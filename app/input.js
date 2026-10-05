// Injects remote mouse/keyboard events into the host OS.
//
// Windows: calls user32 SetCursorPos/SendInput directly via koffi. This gives
// correct multi-monitor positioning and hardware scancodes (layout independent,
// works in games). macOS/Linux: uses libnut.
//
// Events arrive with mouse coordinates normalised to 0..1 of the shared
// display; the caller supplies the display's bounds (in DIPs) to map them.

const { screen } = require('electron');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let backend = null;
let loadError = null;

try {
  backend = isWin ? createWin32Backend() : createLibnutBackend();
} catch (err) {
  loadError = err.message;
  console.error('[input] injection unavailable:', err);
}

const pressedKeys = new Set();
const pressedButtons = new Set();
let remotePlatform = null;
let blocked = false;
let onBlockedChange = () => {};

function setBlocked(value) {
  if (value === blocked) return;
  blocked = value;
  onBlockedChange(blocked);
}

// ---------------------------------------------------------------------------
// Public API

function status() {
  return { available: !!backend, error: loadError };
}

function setRemotePlatform(platform) {
  remotePlatform = platform;
}

function handle(evt, bounds) {
  if (!backend || !evt) return;
  switch (evt.t) {
    case 'mm':
      move(evt, bounds);
      break;
    case 'md':
    case 'mu': {
      if (!BUTTONS.includes(evt.b)) return;
      if (typeof evt.x === 'number') move(evt, bounds);
      const down = evt.t === 'md';
      backend.button(evt.b, down);
      if (down) pressedButtons.add(evt.b); else pressedButtons.delete(evt.b);
      break;
    }
    case 'wh':
      backend.wheel(clampInt(evt.dx, -50, 50), clampInt(evt.dy, -50, 50));
      break;
    case 'kd':
    case 'ku': {
      const code = translateModifier(String(evt.c));
      const down = evt.t === 'kd';
      if (backend.key(code, down)) {
        if (down) pressedKeys.add(code); else pressedKeys.delete(code);
      }
      break;
    }
    case 'ra':
      releaseAll();
      break;
  }
}

// Release anything still held, e.g. when the viewer loses focus or disconnects,
// so the host isn't left with a stuck Ctrl or mouse button.
function releaseAll() {
  if (!backend) return;
  for (const code of pressedKeys) backend.key(code, false);
  for (const b of pressedButtons) backend.button(b, false);
  pressedKeys.clear();
  pressedButtons.clear();
}

function setBlockedListener(fn) {
  onBlockedChange = fn;
}

module.exports = { status, handle, releaseAll, setRemotePlatform, setBlockedListener };

// ---------------------------------------------------------------------------
// Helpers

const BUTTONS = [0, 1, 2, 3, 4]; // left, middle, right, back, forward

function clampInt(v, min, max) {
  v = Math.trunc(Number(v) || 0);
  return Math.max(min, Math.min(max, v));
}

function move(evt, bounds) {
  if (!bounds) return;
  const nx = Math.min(Math.max(Number(evt.x) || 0, 0), 1);
  const ny = Math.min(Math.max(Number(evt.y) || 0, 0), 1);
  const dip = {
    x: Math.round(bounds.x + nx * (bounds.width - 1)),
    y: Math.round(bounds.y + ny * (bounds.height - 1)),
  };
  backend.move(dip);
}

// Cmd on a Mac is the equivalent of Ctrl elsewhere; swap them when exactly one
// side of the connection is a Mac so shortcuts like copy/paste just work.
function translateModifier(code) {
  if (!remotePlatform || (remotePlatform === 'darwin') === isMac) return code;
  const swap = {
    MetaLeft: 'ControlLeft', ControlLeft: 'MetaLeft',
    MetaRight: 'ControlRight', ControlRight: 'MetaRight',
  };
  return swap[code] || code;
}

// ---------------------------------------------------------------------------
// Windows backend

function createWin32Backend() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long', dy: 'long', mouseData: 'int32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32', u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT }),
  });
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)');
  const INPUT_SIZE = koffi.sizeof(INPUT);

  const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_SCANCODE = 0x8;
  const MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000, WHEEL_DELTA = 120;
  const MOUSE_FLAGS = [
    // [down, up, mouseData]
    [0x0002, 0x0004, 0], // left
    [0x0020, 0x0040, 0], // middle
    [0x0008, 0x0010, 0], // right
    [0x0080, 0x0100, 1], // XBUTTON1 (back)
    [0x0080, 0x0100, 2], // XBUTTON2 (forward)
  ];

  // SendInput returns 0 when Windows (UIPI) blocks the input, which happens
  // whenever the foreground window runs as administrator and we don't.
  const send = (input) => setBlocked(SendInput(1, input, INPUT_SIZE) === 0);

  const mouse = (flags, data = 0) => send({
    type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  });

  const keyboard = (vk, scan, flags) => send({
    type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  });

  return {
    move(dip) {
      // Electron is per-monitor DPI aware, so SetCursorPos expects physical pixels.
      const p = screen.dipToScreenPoint(dip);
      SetCursorPos(Math.round(p.x), Math.round(p.y));
    },
    button(b, down) {
      const [d, u, data] = MOUSE_FLAGS[b];
      mouse(down ? d : u, data);
    },
    wheel(dx, dy) {
      // Viewer sends browser-style steps: +dy = scroll down, +dx = scroll right.
      if (dy) mouse(MOUSEEVENTF_WHEEL, -dy * WHEEL_DELTA);
      if (dx) mouse(MOUSEEVENTF_HWHEEL, dx * WHEEL_DELTA);
    },
    key(code, down) {
      const up = down ? 0 : KEYEVENTF_KEYUP;
      const sc = WIN_SCANCODES[code];
      if (sc !== undefined) {
        const ext = sc > 0xff ? KEYEVENTF_EXTENDEDKEY : 0;
        keyboard(0, sc & 0xff, KEYEVENTF_SCANCODE | ext | up);
        return true;
      }
      const vk = WIN_VKEYS[code];
      if (vk !== undefined) {
        keyboard(vk, 0, up);
        return true;
      }
      return false;
    },
  };
}

// KeyboardEvent.code -> PC set-1 scancode (0xE0xx = extended key).
const WIN_SCANCODES = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c,
  Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13,
  KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a,
  BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d,
  KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34,
  Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d,
  NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58, IntlRo: 0x73, IntlYen: 0x7d,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037,
  AltRight: 0xe038, NumLock: 0xe045, Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049,
  ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051,
  Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c, ContextMenu: 0xe05d,
};

// Keys without a simple scancode are sent as virtual-key codes.
const WIN_VKEYS = {
  Pause: 0x13, F13: 0x7c, F14: 0x7d, F15: 0x7e, F16: 0x7f, F17: 0x80, F18: 0x81, F19: 0x82,
  F20: 0x83, F21: 0x84, F22: 0x85, F23: 0x86, F24: 0x87,
  AudioVolumeMute: 0xad, AudioVolumeDown: 0xae, AudioVolumeUp: 0xaf,
  MediaTrackNext: 0xb0, MediaTrackPrevious: 0xb1, MediaStop: 0xb2, MediaPlayPause: 0xb3,
};

// ---------------------------------------------------------------------------
// macOS / Linux backend

function createLibnutBackend() {
  const { libnut } = require('@nut-tree-fork/libnut/dist/import_libnut');
  libnut.setMouseDelay(0);
  libnut.setKeyboardDelay(0);
  const BUTTON_NAMES = ['left', 'middle', 'right'];
  // macOS scrolls in pixels, X11 in wheel clicks.
  const WHEEL_UNIT = isMac ? 40 : 1;

  return {
    move(dip) {
      // macOS works in points (= DIPs). X11 works in physical pixels.
      const scale = isMac ? 1 : screen.getDisplayNearestPoint(dip).scaleFactor;
      libnut.moveMouse(Math.round(dip.x * scale), Math.round(dip.y * scale));
    },
    button(b, down) {
      const name = BUTTON_NAMES[b];
      if (name) libnut.mouseToggle(down ? 'down' : 'up', name);
    },
    wheel(dx, dy) {
      // libnut convention: positive y = up, negative x = right.
      libnut.scrollMouse(-dx * WHEEL_UNIT, -dy * WHEEL_UNIT);
    },
    key(code, down) {
      const name = libnutKeyName(code);
      if (!name) return false;
      libnut.keyToggle(name, down ? 'down' : 'up');
      return true;
    },
  };
}

const LIBNUT_KEYS = {
  Escape: 'escape', Backspace: 'backspace', Tab: 'tab', Enter: 'enter', Space: 'space',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', CapsLock: 'caps_lock',
  ShiftLeft: 'shift', ShiftRight: 'right_shift', ControlLeft: 'control', ControlRight: 'right_control',
  AltLeft: 'alt', AltRight: 'right_alt', MetaLeft: 'meta', MetaRight: 'right_meta',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert', Delete: 'delete',
  PrintScreen: 'printscreen', ScrollLock: 'scroll_lock', NumLock: 'num_lock', ContextMenu: 'menu',
  NumpadAdd: 'add', NumpadSubtract: 'subtract', NumpadMultiply: 'multiply', NumpadDivide: 'divide',
  NumpadDecimal: 'numpad_decimal', NumpadEnter: 'enter', NumpadEqual: 'numpad_equal',
  AudioVolumeMute: 'audio_mute', AudioVolumeDown: 'audio_vol_down', AudioVolumeUp: 'audio_vol_up',
  MediaPlayPause: 'audio_play', MediaStop: 'audio_stop', MediaTrackNext: 'audio_next',
  MediaTrackPrevious: 'audio_prev',
};

function libnutKeyName(code) {
  if (LIBNUT_KEYS[code]) return LIBNUT_KEYS[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].toLowerCase();
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return `numpad_${m[1]}`;
  if ((m = /^F(\d{1,2})$/.exec(code)) && +m[1] >= 1 && +m[1] <= 24) return `f${m[1]}`;
  return null;
}
