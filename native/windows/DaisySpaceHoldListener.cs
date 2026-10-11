using System;
using System.Runtime.InteropServices;
using System.Threading;

internal static class DaisySpaceHoldListener
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const int WmQuit = 0x0012;
    private const int WmReplaySpace = 0x8001;
    private const int VkSpace = 0x20;
    private const uint LlkhfInjected = 0x10;
    private const uint KeyEventUp = 0x0002;
    private const int SpaceHoldMs = 300;

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public uint vkCode, scanCode, flags, time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyboardInput keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort virtualKey, scanCode;
        public uint flags, time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr hWnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x, y;
    }

    private delegate IntPtr KeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, KeyboardProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    private static readonly object OutputLock = new object();
    private static readonly object StateLock = new object();
    private static readonly KeyboardProc Callback = OnKeyboard;
    private static IntPtr hook;
    private static uint mainThread;
    private static bool capturing;
    private static bool holdStarted;
    private static Timer holdTimer;
    private static volatile bool paused;

    private static void WriteLine(string line)
    {
        lock (OutputLock) {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool ModifierDown()
    {
        return (GetAsyncKeyState(0x10) & 0x8000) != 0 ||
               (GetAsyncKeyState(0x11) & 0x8000) != 0 ||
               (GetAsyncKeyState(0x12) & 0x8000) != 0 ||
               (GetAsyncKeyState(0x5b) & 0x8000) != 0 ||
               (GetAsyncKeyState(0x5c) & 0x8000) != 0;
    }

    private static void ReplaySpace()
    {
        Input down = new Input();
        down.type = 1;
        down.data.keyboard.virtualKey = VkSpace;
        Input up = down;
        up.data.keyboard.flags = KeyEventUp;
        if (SendInput(2, new Input[] { down, up }, Marshal.SizeOf(typeof(Input))) != 2)
            WriteLine("ERROR:SPACE_REPLAY:" + Marshal.GetLastWin32Error());
    }

    private static void ClearHeldSpace()
    {
        Input up = new Input();
        up.type = 1;
        up.data.keyboard.virtualKey = VkSpace;
        up.data.keyboard.flags = KeyEventUp;
        if (SendInput(1, new Input[] { up }, Marshal.SizeOf(typeof(Input))) != 1)
            WriteLine("ERROR:SPACE_RELEASE:" + Marshal.GetLastWin32Error());
    }

    private static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(hook, code, wParam, lParam);
        KbdLlHookStruct key = (KbdLlHookStruct)Marshal.PtrToStructure(lParam, typeof(KbdLlHookStruct));
        if (key.vkCode != VkSpace || (key.flags & LlkhfInjected) != 0)
            return CallNextHookEx(hook, code, wParam, lParam);

        int action = wParam.ToInt32();
        if (action == WmKeyDown || action == WmSysKeyDown) {
            lock (StateLock) {
                if (!capturing) {
                    if (paused || ModifierDown()) return CallNextHookEx(hook, code, wParam, lParam);
                    capturing = true;
                    holdStarted = false;
                    ClearHeldSpace();
                    holdTimer = new Timer(delegate {
                        lock (StateLock) {
                            if (!capturing || holdStarted) return;
                            holdStarted = true;
                            WriteLine("WAKE_DOWN");
                        }
                    }, null, SpaceHoldMs, Timeout.Infinite);
                }
            }
            return new IntPtr(1);
        }
        if (action == WmKeyUp || action == WmSysKeyUp) {
            bool wasHeld;
            lock (StateLock) {
                if (!capturing) return CallNextHookEx(hook, code, wParam, lParam);
                capturing = false;
                holdTimer.Dispose();
                holdTimer = null;
                wasHeld = holdStarted;
                if (wasHeld) WriteLine("WAKE_UP");
            }
            if (!wasHeld) PostThreadMessage(mainThread, WmReplaySpace, UIntPtr.Zero, IntPtr.Zero);
            return new IntPtr(1);
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private static void Main()
    {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        mainThread = GetCurrentThreadId();
        hook = SetWindowsHookEx(WhKeyboardLl, Callback, IntPtr.Zero, 0);
        if (hook == IntPtr.Zero) {
            WriteLine("ERROR:" + Marshal.GetLastWin32Error());
            return;
        }
        Message initial;
        PeekMessage(out initial, IntPtr.Zero, 0, 0, 0);
        WriteLine("READY");
        Thread reader = new Thread(delegate() {
            string command;
            while ((command = Console.ReadLine()) != null) {
                if (command == "PAUSE") paused = true;
                else if (command == "RESUME") paused = false;
                else if (command == "EXIT") break;
            }
            PostThreadMessage(mainThread, WmQuit, UIntPtr.Zero, IntPtr.Zero);
        });
        reader.IsBackground = true;
        reader.Start();
        Message message;
        while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
            if (message.message == WmReplaySpace) { ReplaySpace(); continue; }
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        UnhookWindowsHookEx(hook);
    }
}
