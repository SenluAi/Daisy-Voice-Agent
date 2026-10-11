using System;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class DaisyAutomationHelper
{
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT
    {
        public ushort virtualKey, scanCode;
        public uint flags, time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool GetPhysicalCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, int data, IntPtr extraInfo);
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("missing command arguments");
            string command = args[0];
            if (command == "mouse-action" || command == "mouse-probe") return MouseAction(args, command == "mouse-probe");
            string processName = Decode(args[1]);
            if (command == "open-contact")
            {
                if (args.Length < 3) throw new ArgumentException("missing contact");
                return OpenContact(processName, Decode(args[2]));
            }
            if (command == "stage-file")
            {
                if (args.Length < 3) throw new ArgumentException("missing file path");
                return StageFile(processName, Decode(args[2]));
            }
            if (command == "confirm-attachment") return ConfirmAttachment(processName);
            throw new ArgumentException("unknown command: " + command);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static string Decode(string value)
    {
        return Encoding.Unicode.GetString(Convert.FromBase64String(value));
    }

    private static void MouseInput(uint flags, int data)
    {
        INPUT input = new INPUT();
        input.type = 0;
        input.data.mouse.flags = flags;
        input.data.mouse.mouseData = unchecked((uint)data);
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("mouse SendInput failed");
    }

    private static int MouseAction(string[] args, bool probe)
    {
        if (args.Length != 7) throw new ArgumentException("mouse arguments: action x y endX endY direction");
        string action = args[1];
        if (action != "click" && action != "double" && action != "right" && action != "scroll" && action != "drag")
            throw new ArgumentException("invalid mouse action");
        int x = int.Parse(args[2], CultureInfo.InvariantCulture);
        int y = int.Parse(args[3], CultureInfo.InvariantCulture);
        int endX = int.Parse(args[4], CultureInfo.InvariantCulture);
        int endY = int.Parse(args[5], CultureInfo.InvariantCulture);
        string direction = args[6];
        if (action == "scroll" && direction != "up" && direction != "down" && direction != "left" && direction != "right")
            throw new ArgumentException("invalid scroll direction");
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
            throw new InvalidOperationException("per-monitor DPI awareness failed");
        if (probe) { Console.WriteLine("MOUSE_READY"); return 0; }
        MovePhysicalCursor(x, y);
        if (action == "scroll")
        {
            MouseInput(direction == "left" || direction == "right" ? 0x1000u : 0x0800u,
                direction == "up" || direction == "right" ? 720 : -720);
        }
        else
        {
            uint down = action == "right" ? 8u : 2u;
            uint up = action == "right" ? 16u : 4u;
            try
            {
                MouseInput(down, 0);
                if (action == "drag")
                    for (int i = 1; i <= 12; i++)
                    {
                        MovePhysicalCursor(x + (endX - x) * i / 12, y + (endY - y) * i / 12);
                        Thread.Sleep(18);
                    }
            }
            finally { MouseInput(up, 0); }
            if (action == "double")
            {
                Thread.Sleep(90);
                try { MouseInput(down, 0); }
                finally { MouseInput(up, 0); }
            }
        }
        Console.WriteLine("MOUSE_EXECUTED");
        return 0;
    }

    private static void MovePhysicalCursor(int x, int y)
    {
        POINT point;
        if (!SetCursorPos(x, y) || !GetPhysicalCursorPos(out point) || point.X != x || point.Y != y)
            throw new InvalidOperationException("physical cursor position mismatch; input not repeated");
    }

    private static bool FindLargestWindow(string processName, out Process target, out RECT targetRect)
    {
        target = null;
        targetRect = new RECT();
        long largestArea = -1;
        foreach (Process candidate in Process.GetProcessesByName(processName))
        {
            if (candidate.MainWindowHandle == IntPtr.Zero) continue;
            RECT rect;
            if (!GetWindowRect(candidate.MainWindowHandle, out rect)) continue;
            long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
            if (area <= largestArea) continue;
            largestArea = area;
            target = candidate;
            targetRect = rect;
        }
        return target != null;
    }

    private static void Activate(Process target)
    {
        ShowWindow(target.MainWindowHandle, 9);
        SetForegroundWindow(target.MainWindowHandle);
        Thread.Sleep(80);
    }

    private static void Click(int x, int y)
    {
        SetCursorPos(x, y);
        mouse_event(2, 0, 0, 0, IntPtr.Zero);
        mouse_event(4, 0, 0, 0, IntPtr.Zero);
    }

    private static void SelectAll()
    {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x41, 0, 0, UIntPtr.Zero);
        keybd_event(0x41, 0, 2, UIntPtr.Zero);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
    }

    private static void Paste()
    {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        keybd_event(0x56, 0, 0, UIntPtr.Zero);
        keybd_event(0x56, 0, 2, UIntPtr.Zero);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
    }

    private static bool TypeText(string text)
    {
        foreach (char value in text)
        {
            INPUT down = new INPUT();
            down.type = 1;
            down.data.keyboard.scanCode = value;
            down.data.keyboard.flags = 4;
            INPUT up = down;
            up.data.keyboard.flags = 6;
            if (SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) return false;
        }
        return true;
    }

    private static int OpenContact(string processName, string contact)
    {
        Process target;
        RECT rect;
        if (!FindLargestWindow(processName, out target, out rect))
        {
            Console.WriteLine("NOT_FOUND");
            return 0;
        }
        Activate(target);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        Click(rect.Left + (int)(width * 0.125), rect.Top + (int)(height * 0.085));
        Thread.Sleep(60);
        SelectAll();
        if (!TypeText(contact)) throw new InvalidOperationException("SendInput failed");
        Thread.Sleep(220);
        Console.WriteLine("CONTACT_RESULTS_READY");
        return 0;
    }

    private static int StageFile(string processName, string filePath)
    {
        if (!File.Exists(filePath)) throw new FileNotFoundException("file not found", filePath);
        Process target;
        RECT rect;
        if (!FindLargestWindow(processName, out target, out rect)) throw new InvalidOperationException("main window not found");
        StringCollection files = new StringCollection();
        files.Add(Path.GetFullPath(filePath));
        Clipboard.SetFileDropList(files);
        Activate(target);
        Paste();
        Console.WriteLine("STAGED");
        return 0;
    }

    private static int ConfirmAttachment(string processName)
    {
        Process target;
        RECT rect;
        if (!FindLargestWindow(processName, out target, out rect)) throw new InvalidOperationException("main window not found");
        Activate(target);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        double yRatio = processName.Equals("QQ", StringComparison.OrdinalIgnoreCase) ? 0.695 : 0.70;
        Click(rect.Left + (int)(width * 0.50), rect.Top + (int)(height * yRatio));
        Console.WriteLine("CONFIRMED");
        return 0;
    }
}
