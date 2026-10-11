using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class DaisyWechatInputHost : Form
{
    [ComImport, Guid("71C6E74C-0F28-11D8-A82A-00065B84435C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITfInputProcessorProfileMgr
    {
        [PreserveSig]
        int ActivateProfile(uint profileType, ushort langId, ref Guid clsid, ref Guid profile, IntPtr hkl, uint flags);
    }

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

    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);

    private const uint KeyEventUp = 0x0002;
    private const uint ScanCode = 0x0008;
    private const uint ExtendedKey = 0x0001;
    private static readonly object OutputLock = new object();
    private readonly TextBox capture = new TextBox();
    private static int lastError;
    private bool shortcutHeld;
    private bool toggleActive;
    private IntPtr previousForeground;

    protected override bool ShowWithoutActivation { get { return true; } }

    public DaisyWechatInputHost()
    {
        previousForeground = GetForegroundWindow();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Size = new Size(260, 72);
        Rectangle desktop = SystemInformation.VirtualScreen;
        Location = new Point(desktop.Right + 32, desktop.Bottom + 32);

        capture.Multiline = true;
        capture.Dock = DockStyle.Fill;
        capture.BorderStyle = BorderStyle.None;
        capture.TextChanged += delegate {
            WriteLine("TEXT:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(capture.Text)));
        };
        Controls.Add(capture);
        Activated += delegate { capture.Focus(); };
        Shown += delegate {
            BeginInvoke(new Action(delegate {
                WriteLine("READY:" + Handle.ToInt64());
                if (previousForeground != IntPtr.Zero) SetForegroundWindow(previousForeground);
            }));
        };
        FormClosing += delegate { ReleaseShortcut(); StopToggle(); };
        FormClosed += delegate {
            if (previousForeground != IntPtr.Zero && previousForeground != Handle)
                SetForegroundWindow(previousForeground);
        };
    }

    private static void WriteLine(string line)
    {
        lock (OutputLock) {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static bool SendScan(ushort code, bool extended, bool up)
    {
        INPUT input = new INPUT();
        input.type = 1;
        input.data.keyboard.scanCode = code;
        input.data.keyboard.flags = ScanCode | (extended ? ExtendedKey : 0) | (up ? KeyEventUp : 0);
        bool sent = SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
        if (!sent) lastError = Marshal.GetLastWin32Error();
        return sent;
    }

    private bool FocusCapture()
    {
        ShowWindow(Handle, 5);
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        // Acquire the receiver focus without injecting keys into the user's application.
        bool attached = foregroundThread != 0 && foregroundThread != currentThread &&
            AttachThreadInput(currentThread, foregroundThread, true);
        try {
            SetForegroundWindow(Handle);
            BringWindowToTop(Handle);
        } finally {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
        Thread.Sleep(120);
        return GetForegroundWindow() == Handle && capture.Focus();
    }

    private static bool ActivateWechatProfile()
    {
        const string root = @"SOFTWARE\Microsoft\CTF\TIP";
        using (RegistryKey tips = Registry.LocalMachine.OpenSubKey(root)) {
            if (tips == null) return false;
            foreach (string tipName in tips.GetSubKeyNames()) {
                using (RegistryKey profiles = tips.OpenSubKey(tipName + @"\LanguageProfile\0x00000804")) {
                    if (profiles == null) continue;
                    foreach (string profileName in profiles.GetSubKeyNames()) {
                        using (RegistryKey profileKey = profiles.OpenSubKey(profileName)) {
                            string description = profileKey == null ? null : profileKey.GetValue("Description") as string;
                            if (description == null || (description.IndexOf("WeType", StringComparison.OrdinalIgnoreCase) < 0 &&
                                description.IndexOf("微信输入法", StringComparison.OrdinalIgnoreCase) < 0)) continue;
                        }
                        Guid clsid;
                        Guid profile;
                        if (!Guid.TryParse(tipName, out clsid) || !Guid.TryParse(profileName, out profile)) continue;
                        object manager = Activator.CreateInstance(Type.GetTypeFromCLSID(
                            new Guid("33C53A50-F456-4884-B049-85FD643ECFED")));
                        try {
                            int result = ((ITfInputProcessorProfileMgr)manager).ActivateProfile(
                                1, 0x0804, ref clsid, ref profile, IntPtr.Zero, 0);
                            WriteLine("DIAG:WECHAT_PROFILE:0x" + result.ToString("X8"));
                            return result == 0;
                        } finally {
                            Marshal.ReleaseComObject(manager);
                        }
                    }
                }
            }
        }
        return false;
    }

    private bool HoldShortcut()
    {
        previousForeground = GetForegroundWindow();
        if (!FocusCapture()) return false;
        try {
            if (!ActivateWechatProfile()) return false;
        } catch (Exception error) {
            WriteLine("DIAG:WECHAT_PROFILE:ERROR:" + error.GetType().Name);
            return false;
        }
        if (GetForegroundWindow() != Handle || !capture.Focused) return false;
        bool spaceBefore = (GetAsyncKeyState(0x20) & 0x8000) != 0;
        // Keep the physical wake key out of WeType's hold shortcut state.
        SendScan(0x39, false, true);
        Thread.Sleep(35);
        bool spaceAfter = (GetAsyncKeyState(0x20) & 0x8000) != 0;
        WriteLine("DIAG:HOLD_KEYS:space=" + spaceBefore + "/" + spaceAfter + ":focused=" + (GetForegroundWindow() == Handle));
        if (!SendScan(0x1d, false, false)) return false;
        Thread.Sleep(25);
        if (!SendScan(0x38, false, false)) {
            SendScan(0x1d, false, true);
            return false;
        }
        Thread.Sleep(25);
        if (!SendScan(0x43, false, false)) {
            SendScan(0x38, false, true);
            SendScan(0x1d, false, true);
            return false;
        }
        shortcutHeld = true;
        return true;
    }

    private bool ReleaseShortcut()
    {
        if (!shortcutHeld) return true;
        bool f9Released = SendScan(0x43, false, true);
        bool altReleased = SendScan(0x38, false, true);
        bool controlReleased = SendScan(0x1d, false, true);
        shortcutHeld = false;
        return f9Released && altReleased && controlReleased;
    }

    private bool TapToggle()
    {
        if (GetForegroundWindow() != Handle || !capture.Focused) return false;
        if (!SendScan(0x1d, false, false)) return false;
        Thread.Sleep(25);
        if (!SendScan(0x5b, true, false)) { SendScan(0x1d, false, true); return false; }
        Thread.Sleep(25);
        if (!SendScan(0x2a, false, false)) {
            SendScan(0x5b, true, true);
            SendScan(0x1d, false, true);
            return false;
        }
        Thread.Sleep(60);
        bool shiftReleased = SendScan(0x2a, false, true);
        Thread.Sleep(15);
        bool windowsReleased = SendScan(0x5b, true, true);
        Thread.Sleep(15);
        bool controlReleased = SendScan(0x1d, false, true);
        return shiftReleased && windowsReleased && controlReleased;
    }

    private bool StartToggle()
    {
        previousForeground = GetForegroundWindow();
        if (!FocusCapture() || !TapToggle()) return false;
        toggleActive = true;
        return true;
    }

    private bool StopToggle()
    {
        if (!toggleActive) return true;
        bool stopped = FocusCapture() && TapToggle();
        if (stopped) toggleActive = false;
        return stopped;
    }

    private static bool WechatRunning()
    {
        System.Diagnostics.Process[] processes = System.Diagnostics.Process.GetProcessesByName("wetype_server");
        foreach (System.Diagnostics.Process process in processes) process.Dispose();
        return processes.Length > 0;
    }

    private static bool EnsureWechatRunning()
    {
        if (WechatRunning()) return true;
        try { System.Diagnostics.Process.Start("ctfmon.exe"); }
        catch { return false; }
        for (int attempt = 0; attempt < 10; attempt++) {
            Thread.Sleep(100);
            if (WechatRunning()) return true;
        }
        return false;
    }

    public void Execute(string command)
    {
        if (command == "EXIT") { ReleaseShortcut(); StopToggle(); Close(); return; }
        if (command != "START_HOLD" && command != "STOP_HOLD" &&
            command != "START_TOGGLE" && command != "STOP_TOGGLE") return;
        lastError = 0;
        bool sent;
        if (command.StartsWith("START_")) {
            if (!EnsureWechatRunning()) { WriteLine("STARTED:false:WECHAT_NOT_RUNNING"); return; }
            capture.Clear();
            sent = command == "START_HOLD" ? HoldShortcut() : StartToggle();
        } else {
            sent = command == "STOP_HOLD" ? ReleaseShortcut() : StopToggle();
        }
        WriteLine((command.StartsWith("START_") ? "STARTED:" : "STOPPED:") + sent + ":" + lastError);
    }

    [STAThread]
    private static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        DaisyWechatInputHost form = new DaisyWechatInputHost();
        Thread reader = new Thread(delegate() {
            string command;
            while ((command = Console.ReadLine()) != null) {
                string pending = command;
                try { form.BeginInvoke(new Action(delegate { form.Execute(pending); })); }
                catch (InvalidOperationException) { break; }
            }
            try { form.BeginInvoke(new Action(delegate { form.Close(); })); }
            catch (InvalidOperationException) { }
        });
        reader.IsBackground = true;
        reader.Start();
        Application.Run(form);
    }
}
