# ⌨️ Keyboard Punch

**Turn your Android phone into a USB keyboard for your laptop.**

Type or paste text on your phone, press "Start Punching", and watch it get typed out on your laptop — character by character, at your chosen speed (10–250 WPM).

---

## How It Works

```
📱 Phone (Chrome)  ──USB-C──►  💻 Laptop (Python)  ──►  🖥️ Active App
   Web App UI          ADB        Companion Script       Keystroke Sim
                     Reverse
```

1. The **companion script** runs on your laptop — it sets up ADB reverse port forwarding over USB-C
2. You open **Chrome on your phone** → `http://localhost:8080`
3. Type/paste text, set speed, press **"Start Punching"**
4. Text is sent via WebSocket through the USB cable
5. The script types it into whatever app has focus on your laptop

> **No Wi-Fi needed.** All communication happens through the USB-C cable.

---

## Prerequisites

| Requirement | How to Get It |
|-------------|---------------|
| **Python 3.8+** | Usually pre-installed on macOS/Linux. For Windows, download from python.org. Check: `python3 --version` |
| **ADB** | **Windows:** Run `winget install Google.PlatformTools` in PowerShell<br>**macOS:** Run `brew install android-platform-tools` in Terminal<br>**Linux (Ubuntu/Debian):** Run `sudo apt install adb` |
| **USB Debugging** | On your phone: Settings → About Phone → Tap "Build Number" 7 times → Back → Developer Options → Enable "USB Debugging" |
| **USB Cable** | A data-capable USB cable (not charge-only) |

---

## Quick Start

### 1. Connect your phone via USB-C

Plug in your Android phone. If prompted on the phone, tap **"Allow USB Debugging"**.

### 2. Run the companion script

```bash
# Option A: One-command launcher
chmod +x companion/start.sh
./companion/start.sh

# Option B: Manual
pip3 install -r companion/requirements.txt
python3 companion/server.py
```

### 3. Open the app on your phone

Open **Chrome** on your phone and navigate to:

```
http://localhost:8080
```

### 4. Start punching!

1. Type or paste your text in the text box
2. Adjust typing speed (10–250 WPM)
3. Click to the target app on your laptop (e.g., VS Code, Terminal)
4. Press **"Start Punching"** on your phone
5. The 3-second countdown gives you time to focus the target app

---

## Features

- **⚡ Adjustable Speed** — 10 to 250 WPM with real-time preview
- **📝 Full Formatting** — Newlines, tabs, spaces, special characters
- **⏱️ Focus Countdown** — 3-second delay to switch to target app
- **📊 Live Progress** — Real-time progress bar with ETA
- **🛑 Emergency Stop** — Stop button or move mouse to screen corner
- **📋 History** — Last 10 sent texts, tap to reuse
- **🔌 Auto-Reconnect** — Reconnects if USB is briefly disconnected
- **🎨 Premium Dark UI** — Glassmorphism design, smooth animations

---

## Verify Setup

Run the built-in test to check everything is configured correctly:

```bash
python3 companion/server.py --test
```

This checks:
- ✅ Python packages installed
- ✅ ADB found and device connected
- ✅ App files present
- ✅ Keyboard simulation working

---

## macOS Permissions

On macOS, you need to grant **Accessibility** permissions to your terminal app for keyboard simulation to work:

1. Go to **System Settings → Privacy & Security → Accessibility**
2. Click the **+** button
3. Add your terminal app (Terminal, iTerm2, VS Code, etc.)
4. Toggle it **ON**

---

## Troubleshooting

### "No Android device detected"
- Make sure USB Debugging is enabled
- Try a different USB-C cable (some are charge-only)
- Run `adb devices` to verify
- On the phone, check for a "USB Debugging" authorization popup

### "localhost:8080 not loading on phone"
- Make sure the companion script is running
- Check that ADB reverse is set up: `adb reverse --list`
- Try: `adb reverse tcp:8080 tcp:8080` manually

### "Typing not working / no keystrokes"
- Grant Accessibility permissions (see macOS Permissions above)
- Make sure the target app has focus on the laptop
- Check pyautogui: `python3 -c "import pyautogui; pyautogui.write('test')"`

### "WebSocket disconnects frequently"
- Try a different USB port
- Make sure the phone screen stays on during punching
- Disable battery optimization for Chrome on the phone

---

## Project Structure

```
keyboard/
├── README.md                  ← You are here
├── app/                       ← Phone-side web app
│   ├── index.html            ← Main page
│   ├── style.css             ← Dark glassmorphism theme
│   └── app.js                ← WebSocket client + UI logic
└── companion/                 ← Laptop-side companion
    ├── server.py             ← Main script (ADB + WebSocket + typing)
    ├── requirements.txt      ← Python dependencies
    └── start.sh              ← One-command launcher
```

---

## Safety

- **Mouse Failsafe**: Move your mouse to any screen corner to immediately stop all typing (pyautogui built-in safety)
- **Stop Button**: Press the Stop button on the phone app at any time
- **Ctrl+C**: Press Ctrl+C in the terminal to shut down everything

---

## License

MIT
