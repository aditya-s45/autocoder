#!/usr/bin/env python3
"""
Keyboard Punch — Laptop Companion Script

Receives text from the Android phone app via WebSocket (over ADB reverse USB)
and simulates keyboard input using pyautogui.

Usage:
    python server.py          # Normal mode
    python server.py --test   # Test mode (verify setup)

Architecture:
    Phone (Chrome) ←→ ADB Reverse ←→ This Script ←→ pyautogui → Active App
"""

import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
import random
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

# ─── Dependency Check ─────────────────────────────────────────
def check_dependencies():
    """Check and install required Python packages."""
    missing = []
    try:
        import websockets
    except ImportError:
        missing.append('websockets')
    
    try:
        import pyautogui
    except ImportError:
        missing.append('pyautogui')
        
    try:
        import pyperclip
    except ImportError:
        missing.append('pyperclip')
    
    if missing:
        print(f"📦 Installing missing packages: {', '.join(missing)}")
        subprocess.check_call([
            sys.executable, '-m', 'pip', 'install', '--quiet', *missing
        ])
        print("✅ Packages installed successfully")

check_dependencies()

import websockets
import pyautogui
import pyperclip

# ─── Configuration ────────────────────────────────────────────
WS_PORT = 8765
HTTP_PORT = 8080
APP_DIR = Path(__file__).parent.parent / 'app'

# pyautogui safety settings
pyautogui.FAILSAFE = True    # Move mouse to corner to abort
pyautogui.PAUSE = 0          # We handle our own delays

def ws_is_open(websocket):
    """Check if a WebSocket connection is still open (compatible with all versions)."""
    try:
        return websocket.state.name == 'OPEN'
    except AttributeError:
        try:
            return websocket.open
        except AttributeError:
            return True

# ─── Colors for terminal output ───────────────────────────────
class Color:
    PURPLE = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    END = '\033[0m'

def log(icon, message, color=Color.END):
    """Pretty-print a log message."""
    print(f"  {icon}  {color}{message}{Color.END}")

def log_header(title):
    """Print a section header."""
    print(f"\n{Color.PURPLE}{Color.BOLD}{'─' * 50}{Color.END}")
    print(f"  {Color.PURPLE}{Color.BOLD}{title}{Color.END}")
    print(f"{Color.PURPLE}{Color.BOLD}{'─' * 50}{Color.END}\n")

# ─── ADB Setup ────────────────────────────────────────────────
def check_adb():
    """Verify ADB is available and a device is connected."""
    # Check if adb exists
    try:
        result = subprocess.run(
            ['adb', 'version'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return False, "ADB not found. Install Android SDK Platform Tools."
    except FileNotFoundError:
        return False, (
            "ADB not found on PATH.\n"
            "  Install via: brew install android-platform-tools  (macOS)\n"
            "  Or download: https://developer.android.com/tools/releases/platform-tools"
        )
    except subprocess.TimeoutExpired:
        return False, "ADB timed out."

    # Check for connected devices
    result = subprocess.run(
        ['adb', 'devices'],
        capture_output=True, text=True, timeout=10
    )
    lines = [l.strip() for l in result.stdout.strip().split('\n')[1:] if l.strip()]
    devices = [l for l in lines if 'device' in l and 'offline' not in l]

    if not devices:
        return False, (
            "No Android device detected.\n"
            "  1. Connect your phone via USB-C cable\n"
            "  2. Enable USB Debugging (Settings → Developer Options)\n"
            "  3. Accept the USB debugging prompt on your phone"
        )
    
    return True, devices[0].split('\t')[0]

def setup_adb_reverse():
    """Set up ADB reverse port forwarding for both WebSocket and HTTP."""
    log('🔌', 'Setting up ADB reverse port forwarding...', Color.CYAN)
    
    errors = []
    for port, name in [(WS_PORT, 'WebSocket'), (HTTP_PORT, 'HTTP')]:
        try:
            result = subprocess.run(
                ['adb', 'reverse', f'tcp:{port}', f'tcp:{port}'],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                log('✓', f'{name} port {port} forwarded', Color.GREEN)
            else:
                errors.append(f'{name} port {port}: {result.stderr.strip()}')
        except Exception as e:
            errors.append(f'{name} port {port}: {str(e)}')
    
    if errors:
        for err in errors:
            log('✕', err, Color.RED)
        return False
    return True

def cleanup_adb_reverse():
    """Remove ADB reverse port forwarding."""
    try:
        subprocess.run(
            ['adb', 'reverse', '--remove-all'],
            capture_output=True, timeout=5
        )
    except Exception:
        pass

# ─── HTTP Server (serves the phone web app) ──────────────────
class ReusableHTTPServer(HTTPServer):
    """HTTP server with SO_REUSEADDR to avoid 'Address already in use' on restart."""
    allow_reuse_address = True
    allow_reuse_port = True

class QuietHTTPHandler(SimpleHTTPRequestHandler):
    """HTTP handler that serves the app/ directory silently."""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)
    
    def log_message(self, format, *args):
        """Suppress HTTP access logs."""
        pass

def start_http_server():
    """Start the HTTP server in a background thread."""
    server = ReusableHTTPServer(('0.0.0.0', HTTP_PORT), QuietHTTPHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log('🌐', f'HTTP server running on port {HTTP_PORT}', Color.GREEN)
    return server

# ─── Keyboard Simulation ─────────────────────────────────────

# Map of special characters to their pyautogui key names
SPECIAL_KEYS = {
    '\n': 'enter',
    '\r': 'enter',
    '\t': 'tab',
}

async def type_text(text, delay_ms, preserve_formatting, ws_client):
    """
    Type text character by character with the specified delay.
    Sends progress updates back to the phone via WebSocket.
    """
    total = len(text)
    
    for i, char in enumerate(text):
        # Check if we should stop (client might have sent a stop message)
        if not ws_is_open(ws_client):
            return False
        
        try:
            if char in SPECIAL_KEYS and preserve_formatting:
                pyautogui.press(SPECIAL_KEYS[char])
            elif char == '\r':
                # Skip \r in \r\n pairs
                continue
            elif char == '\n' and not preserve_formatting:
                # Skip newlines if not preserving formatting
                pyautogui.typewrite(' ', interval=0)
            elif char == '\t' and not preserve_formatting:
                # Convert tabs to spaces if not preserving
                pyautogui.typewrite('    ', interval=0)
            else:
                # Regular character
                pyautogui.write(char)
        except Exception as e:
            await ws_client.send(json.dumps({
                'type': 'error',
                'message': f'Typing error at char {i}: {str(e)}'
            }))
            return False
        
        # Send progress update every 5 characters or at the end
        if i % 5 == 0 or i == total - 1:
            try:
                await ws_client.send(json.dumps({
                    'type': 'progress',
                    'current': i + 1,
                    'total': total
                }))
            except Exception:
                return False
        
        # Delay between keystrokes
        if delay_ms > 0 and i < total - 1:
            await asyncio.sleep(delay_ms / 1000.0)
    
    return True

# ─── WebSocket Server & Multi-Device Sync ─────────────────────

# Track all connected WebSocket clients (mobile phone, laptop browser tabs, etc.)
connected_clients = set()

# Shared state synchronized across all devices
shared_state = {
    'text': '',
    'wpm': 100,
    'focus_delay_sec': 3,
    'preserve_formatting': True,
    'paste_mode': False,
    'jitter_mode': False,
    'burst_mode': False
}

# Track active punching task so we can cancel it
active_task = None
should_stop = False

async def broadcast(message_dict, sender=None, exclude_sender=False):
    """Send a message to all connected clients."""
    payload = json.dumps(message_dict)
    disconnected = []
    for client in list(connected_clients):
        if exclude_sender and client == sender:
            continue
        if ws_is_open(client):
            try:
                await client.send(payload)
            except Exception:
                disconnected.append(client)
        else:
            disconnected.append(client)
    for client in disconnected:
        connected_clients.discard(client)

async def handle_client(websocket):
    """Handle a WebSocket connection from a phone or laptop app."""
    global active_task, should_stop, shared_state
    
    client_ip = websocket.remote_address[0] if websocket.remote_address else 'unknown'
    connected_clients.add(websocket)
    log('📱', f'Device connected from {client_ip} (Total connected: {len(connected_clients)})', Color.GREEN)
    
    try:
        # Send current shared state to newly connected client
        await websocket.send(json.dumps({
            'type': 'sync_state',
            'state': shared_state
        }))

        async for raw_message in websocket:
            try:
                msg = json.loads(raw_message)
            except json.JSONDecodeError:
                continue
            
            msg_type = msg.get('type', '')

            if msg_type == 'update_code':
                new_text = msg.get('text', '')
                shared_state['text'] = new_text
                if 'wpm' in msg:
                    shared_state['wpm'] = msg['wpm']
                if 'focus_delay_sec' in msg:
                    shared_state['focus_delay_sec'] = msg['focus_delay_sec']
                if 'preserve_formatting' in msg:
                    shared_state['preserve_formatting'] = msg['preserve_formatting']
                if 'paste_mode' in msg:
                    shared_state['paste_mode'] = msg['paste_mode']
                if 'jitter_mode' in msg:
                    shared_state['jitter_mode'] = msg['jitter_mode']
                if 'burst_mode' in msg:
                    shared_state['burst_mode'] = msg['burst_mode']

                log('🔄', f'Code updated ({len(new_text)} chars) from {client_ip}. Syncing to {len(connected_clients)} device(s)', Color.CYAN)
                
                # Broadcast updated code to all connected clients
                await broadcast({
                    'type': 'code_updated',
                    'text': new_text,
                    'wpm': shared_state['wpm'],
                    'focus_delay_sec': shared_state['focus_delay_sec'],
                    'preserve_formatting': shared_state['preserve_formatting'],
                    'paste_mode': shared_state['paste_mode'],
                    'jitter_mode': shared_state['jitter_mode'],
                    'burst_mode': shared_state['burst_mode'],
                    'sender': client_ip
                })
            
            elif msg_type == 'punch':
                text = msg.get('text', '')
                delay_ms = msg.get('delay_ms', 50)
                preserve = msg.get('preserve_formatting', True)
                paste_mode = msg.get('paste_mode', False)
                jitter_mode = msg.get('jitter_mode', False)
                burst_mode = msg.get('burst_mode', False)
                wpm = msg.get('wpm', 100)
                
                if not text:
                    await websocket.send(json.dumps({
                        'type': 'error',
                        'message': 'No text to type'
                    }))
                    continue
                
                # Save into shared state
                shared_state['text'] = text
                shared_state['wpm'] = wpm
                shared_state['preserve_formatting'] = preserve
                shared_state['paste_mode'] = paste_mode
                shared_state['jitter_mode'] = jitter_mode
                shared_state['burst_mode'] = burst_mode

                if paste_mode:
                    log('📋', f'Pasting {len(text)} chars via clipboard', Color.CYAN)
                else:
                    modes = []
                    if jitter_mode: modes.append('JITTER')
                    if burst_mode: modes.append('BURST')
                    modes_str = f" [{'+'.join(modes)}]" if modes else ""
                    log('⌨️ ', f'Typing {len(text)} chars at {wpm} WPM ({delay_ms}ms base delay){modes_str}', Color.CYAN)
                
                should_stop = False
                
                async def do_punch():
                    global should_stop
                    try:
                        total = len(text)
                        
                        if paste_mode:
                            if should_stop:
                                await broadcast({'type': 'stopped'})
                                log('■', 'Pasting stopped by user', Color.YELLOW)
                                return
                                
                            try:
                                pyperclip.copy(text)
                                if sys.platform == 'darwin':
                                    pyautogui.hotkey('command', 'v')
                                else:
                                    pyautogui.hotkey('ctrl', 'v')
                                    
                                await broadcast({
                                    'type': 'progress',
                                    'current': total,
                                    'total': total
                                })
                                await asyncio.sleep(0.1) # Small buffer
                            except Exception as e:
                                await broadcast({
                                    'type': 'error',
                                    'message': f'Paste error: {str(e)}'
                                })
                                return
                        else:
                            current_word_mult = random.uniform(0.7, 1.3)
                            
                            for i, char in enumerate(text):
                                if should_stop:
                                    await broadcast({'type': 'stopped'})
                                    log('■', 'Typing stopped by user', Color.YELLOW)
                                    return
                                
                                # Check if at least one client is still open
                                if not any(ws_is_open(c) for c in connected_clients):
                                    return
                                
                                try:
                                    if char in SPECIAL_KEYS and preserve:
                                        pyautogui.press(SPECIAL_KEYS[char])
                                    elif char == '\r':
                                        continue
                                    elif char == '\n' and not preserve:
                                        pyautogui.typewrite(' ', interval=0)
                                    elif char == '\t' and not preserve:
                                        pyautogui.typewrite('    ', interval=0)
                                    else:
                                        pyautogui.write(char)
                                except Exception as e:
                                    await broadcast({
                                        'type': 'error',
                                        'message': f'Typing error at position {i}: {str(e)}'
                                    })
                                    return
                                
                                # Progress update every 5 chars or at the end
                                if i % 5 == 0 or i == total - 1:
                                    await broadcast({
                                        'type': 'progress',
                                        'current': i + 1,
                                        'total': total
                                    })
                                
                                if delay_ms > 0 and i < total - 1:
                                    char_delay = delay_ms
                                    
                                    if burst_mode:
                                        char_delay *= current_word_mult
                                        if char in [' ', '\n', '\t', '.', ',', '!', '?']:
                                            # Add a "thinking" pause between words (1.5x to 3.0x normal delay)
                                            char_delay += random.uniform(1.5, 3.0) * delay_ms
                                            # Pick a new typing speed for the next word
                                            current_word_mult = random.uniform(0.7, 1.3)
                                            
                                    if jitter_mode:
                                        # Random variation (Gaussian) around the char_delay
                                        # Standard deviation is 40% of the delay for human-like fluctuation
                                        jittered_ms = random.gauss(char_delay, char_delay * 0.4)
                                        # Ensure delay doesn't go below 1ms
                                        actual_delay = max(1.0, jittered_ms) / 1000.0
                                    else:
                                        actual_delay = max(1.0, char_delay) / 1000.0
                                        
                                    await asyncio.sleep(actual_delay)
                        
                        # Done!
                        await broadcast({'type': 'complete'})
                        log('✅', 'Typing complete!' if not paste_mode else 'Paste complete!', Color.GREEN)
                    
                    except asyncio.CancelledError:
                        log('■', 'Typing cancelled', Color.YELLOW)
                    except Exception as e:
                        log('❌', f'Error: {str(e)}', Color.RED)
                        await broadcast({
                            'type': 'error',
                            'message': str(e)
                        })
                
                # Cancel any existing punch task
                if active_task and not active_task.done():
                    active_task.cancel()
                    try:
                        await active_task
                    except (asyncio.CancelledError, Exception):
                        pass
                
                active_task = asyncio.create_task(do_punch())
            
            elif msg_type == 'stop':
                should_stop = True
                log('⏹', 'Stop requested', Color.YELLOW)
                await broadcast({'type': 'stopped'})
            
            elif msg_type == 'ping':
                await websocket.send(json.dumps({'type': 'pong'}))
    
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(websocket)
        log('📱', f'Device disconnected ({client_ip}). Remaining: {len(connected_clients)}', Color.DIM)
        if not connected_clients:
            should_stop = True

async def start_ws_server():
    """Start the WebSocket server."""
    server = await websockets.serve(
        handle_client,
        '0.0.0.0',
        WS_PORT,
        ping_interval=60,
        ping_timeout=120,
        max_size=10 * 1024 * 1024,  # 10MB max message size
    )
    log('🔗', f'WebSocket server running on port {WS_PORT}', Color.GREEN)
    return server

# ─── Test Mode ────────────────────────────────────────────────
def run_tests():
    """Verify the setup is working correctly."""
    log_header('Keyboard Punch — Setup Test')
    
    all_ok = True
    
    # Test 1: Python packages
    log('1️⃣ ', 'Checking Python packages...', Color.CYAN)
    try:
        import websockets
        log('  ✓', f'websockets {websockets.__version__}', Color.GREEN)
    except Exception as e:
        log('  ✕', f'websockets: {e}', Color.RED)
        all_ok = False
    
    try:
        import pyautogui
        log('  ✓', f'pyautogui {pyautogui.__version__}', Color.GREEN)
    except Exception as e:
        log('  ✕', f'pyautogui: {e}', Color.RED)
        all_ok = False

    try:
        import pyperclip
        log('  ✓', f'pyperclip {pyperclip.__version__}', Color.GREEN)
    except Exception as e:
        log('  ✕', f'pyperclip: {e}', Color.RED)
        all_ok = False
    
    # Test 2: ADB
    log('2️⃣ ', 'Checking ADB...', Color.CYAN)
    ok, info = check_adb()
    if ok:
        log('  ✓', f'Device found: {info}', Color.GREEN)
    else:
        log('  ✕', info, Color.RED)
        all_ok = False
    
    # Test 3: App directory
    log('3️⃣ ', 'Checking app files...', Color.CYAN)
    if APP_DIR.exists():
        files = ['index.html', 'style.css', 'app.js']
        for f in files:
            if (APP_DIR / f).exists():
                log('  ✓', f'{f} found', Color.GREEN)
            else:
                log('  ✕', f'{f} missing', Color.RED)
                all_ok = False
    else:
        log('  ✕', f'App directory not found: {APP_DIR}', Color.RED)
        all_ok = False
    
    # Test 4: pyautogui accessibility (macOS)
    log('4️⃣ ', 'Checking keyboard simulation...', Color.CYAN)
    try:
        # Just check if pyautogui can get screen size (basic sanity check)
        size = pyautogui.size()
        log('  ✓', f'Screen detected: {size.width}x{size.height}', Color.GREEN)
    except Exception as e:
        log('  ✕', f'pyautogui error: {e}', Color.RED)
        log('  💡', 'On macOS: System Settings → Privacy → Accessibility → Enable Terminal', Color.YELLOW)
        all_ok = False
    
    print()
    if all_ok:
        log('🎉', 'All tests passed! Run without --test to start.', Color.GREEN)
    else:
        log('⚠️ ', 'Some tests failed. Fix the issues above and try again.', Color.YELLOW)
    print()
    
    return all_ok

# ─── Main ─────────────────────────────────────────────────────
async def main():
    """Main entry point."""
    log_header('⌨️  Keyboard Punch — Companion')
    
    # Check ADB
    log('🔍', 'Checking ADB connection...', Color.CYAN)
    ok, info = check_adb()
    if not ok:
        log('⚠️ ', info, Color.YELLOW)
        log('💡', 'No USB phone detected yet. Connect phone with USB Debugging for ADB reverse.', Color.DIM)
        log('🌐', 'Starting web & WebSocket servers for Mac browser & local network access...', Color.CYAN)
    else:
        log('✅', f'Device connected: {info}', Color.GREEN)
        if not setup_adb_reverse():
            log('⚠️ ', 'ADB reverse setup failed. Try: adb reverse --remove-all', Color.YELLOW)
    
    # Start HTTP server
    http_server = start_http_server()
    
    # Start WebSocket server
    ws_server = await start_ws_server()
    
    print()
    log_header('🚀 Ready!')
    log('📱', f'Open on your phone:  {Color.BOLD}http://localhost:{HTTP_PORT}{Color.END}', Color.CYAN)
    log('💡', 'Open Chrome on your phone and go to the URL above', Color.DIM)
    log('🛑', f'Press {Color.BOLD}Ctrl+C{Color.END} to stop', Color.DIM)
    log('🛡️', f'Move mouse to screen corner to emergency-stop typing', Color.DIM)
    print()
    
    # Keep running until Ctrl+C
    try:
        await asyncio.Future()  # Run forever
    except asyncio.CancelledError:
        pass
    finally:
        log('👋', 'Shutting down...', Color.DIM)
        ws_server.close()
        await ws_server.wait_closed()
        http_server.shutdown()
        cleanup_adb_reverse()
        log('✅', 'Goodbye!', Color.GREEN)

def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully."""
    print()
    log('👋', 'Shutting down...', Color.DIM)
    cleanup_adb_reverse()
    sys.exit(0)

if __name__ == '__main__':
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    if '--test' in sys.argv:
        success = run_tests()
        sys.exit(0 if success else 1)
    else:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            cleanup_adb_reverse()
