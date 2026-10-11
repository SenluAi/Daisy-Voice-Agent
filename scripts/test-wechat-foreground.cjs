const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const hostPath = path.resolve(__dirname, "../native/windows/DaisyWechatInputHost.cs");

test("WeChat startup does not send Escape or Alt to the foreground application", () => {
  const source = fs.readFileSync(hostPath, "utf8");
  assert.doesNotMatch(source, /SendScan\(0x01\b/, "Escape can close the foreground QQ chat");
  const focus = source.slice(source.indexOf("private bool FocusCapture()"), source.indexOf("private static bool ActivateWechatProfile()"));
  assert.doesNotMatch(focus, /SendScan\(/, "focus acquisition must not inject global keyboard events");
  assert.match(focus, /finally\s*\{\s*if \(attached\) AttachThreadInput\(currentThread, foregroundThread, false\)/);
});

test("native receiver isolates repeated recognition start, stop and cancellation", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-wechat-focus-"));
  try {
    // Keep real window activation but record keys instead of triggering the user's IME.
    let source = fs.readFileSync(hostPath, "utf8");
    const replaceOnce = (pattern, replacement) => {
      assert.match(source, pattern, "native fixture instrumentation must match the host source");
      source = source.replace(pattern, replacement);
    };
    replaceOnce(/\[DllImport\("user32\.dll", SetLastError = true\)\] private static extern uint SendInput\(uint count, INPUT\[\] inputs, int size\);/, `
    private static uint SendInput(uint count, INPUT[] inputs, int size)
    {
        foreach (INPUT input in inputs)
            ForegroundProbe.Record(GetForegroundWindow(), input.data.keyboard.scanCode, input.data.keyboard.flags);
        return count;
    }`);
    replaceOnce(/private static bool EnsureWechatRunning\(\)\s*\{/, "private static bool EnsureWechatRunning() { return true; }\n    private static bool UnusedEnsureWechatRunning() {");
    replaceOnce(/private static bool ActivateWechatProfile\(\)\s*\{/, "private static bool ActivateWechatProfile() { return true; }\n    private static bool UnusedActivateWechatProfile() {");
    replaceOnce(/private bool FocusCapture\(\)\s*\{/, "private bool FocusCapture() { if (ForegroundProbe.BlockFocus) return false;");
    const sourcePath = path.join(directory, "Host.cs");
    const probePath = path.join(directory, "Probe.cs");
    const executable = path.join(directory, "Probe.exe");
    fs.writeFileSync(sourcePath, source);
    fs.writeFileSync(probePath, String.raw`
using System;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class ForegroundProbe
{
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    public static bool BlockFocus;
    private static IntPtr receiver;
    private static int keys;
    private static Form external;
    private static readonly ManualResetEvent ready = new ManualResetEvent(false);

    public static void Record(IntPtr foreground, ushort scan, uint flags)
    {
        Require(foreground == receiver, "recognition key reached another application's window");
        Require(scan != 0x01, "Escape must never be injected by the receiver");
        keys++;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static object Invoke(DaisyWechatInputHost host, string method)
    {
        return typeof(DaisyWechatInputHost).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(host, null);
    }

    private static bool State(DaisyWechatInputHost host, string name)
    {
        return (bool)typeof(DaisyWechatInputHost).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(host);
    }

    private static void FocusExternal()
    {
        external.Invoke(new Action(delegate { external.Activate(); SetForegroundWindow(external.Handle); }));
        Application.DoEvents();
        Require(GetForegroundWindow() == external.Handle, "external fixture did not acquire focus");
    }

    [STAThread]
    private static int Main()
    {
        IntPtr original = GetForegroundWindow();
        Thread externalThread = new Thread(delegate() {
            external = new Form();
            external.ShowInTaskbar = false;
            external.StartPosition = FormStartPosition.Manual;
            Rectangle desktop = SystemInformation.VirtualScreen;
            external.Location = new Point(desktop.Right + 600, desktop.Bottom + 600);
            external.Shown += delegate { ready.Set(); };
            Application.Run(external);
        });
        externalThread.SetApartmentState(ApartmentState.STA);
        externalThread.IsBackground = true;
        externalThread.Start();
        try {
            Require(ready.WaitOne(5000), "external fixture startup timed out");
            for (int round = 0; round < 6; round++) {
                FocusExternal();
                using (DaisyWechatInputHost host = new DaisyWechatInputHost()) {
                    receiver = host.Handle;
                    host.Show();
                    Application.DoEvents();
                    Require(host.Left > SystemInformation.VirtualScreen.Right, "receiver must remain fully off-screen");
                    FocusExternal();
                    int before = keys;
                    host.Execute("START_TOGGLE");
                    Require(State(host, "toggleActive"), "toggle recognition did not start");
                    Require(keys - before == 6, "startup must only send the WeChat toggle chord");
                    FocusExternal();
                    host.Execute("STOP_TOGGLE");
                    Require(!State(host, "toggleActive"), "toggle recognition did not stop");
                    Require(keys - before == 12, "stop must send exactly one toggle chord");
                    host.Execute("EXIT");
                    Require(keys - before == 12, "cleanup must not submit twice");
                }
            }
            FocusExternal();
            using (DaisyWechatInputHost host = new DaisyWechatInputHost()) {
                receiver = host.Handle;
                host.Show();
                Application.DoEvents();
                FocusExternal();
                int before = keys;
                Require(!(bool)Invoke(host, "TapToggle"), "toggle must refuse to run without receiver focus");
                Require(keys == before, "unfocused toggle must not inject keys");
                BlockFocus = true;
                host.Execute("START_TOGGLE");
                host.Execute("START_HOLD");
                Require(keys == before, "failed focus must not inject keys into the user's application");
                Require(!State(host, "toggleActive") && !State(host, "shortcutHeld"), "failed focus must not mark recognition active");
                BlockFocus = false;
                host.Execute("START_TOGGLE");
                Require(State(host, "toggleActive"), "recognition must recover after focus failure");
                FocusExternal();
                host.Execute("EXIT");
                Require(keys - before == 12, "cancel must stop recognition once after refocusing the receiver");
            }
            FocusExternal();
            using (DaisyWechatInputHost host = new DaisyWechatInputHost()) {
                receiver = host.Handle;
                host.Show();
                Application.DoEvents();
                FocusExternal();
                int before = keys;
                host.Execute("START_HOLD");
                Require(State(host, "shortcutHeld"), "hold recognition did not start");
                host.Execute("STOP_HOLD");
                Require(!State(host, "shortcutHeld"), "hold recognition did not release");
                Require(keys - before == 7, "hold must release Space and send/release Ctrl+Alt+F9 once");
                host.Execute("EXIT");
                Require(keys - before == 7, "hold cleanup must not release twice");
            }
            Console.WriteLine("FOREGROUND_PROBE_OK rounds=6 externalKeys=0 escapeKeys=0");
            return 0;
        } catch (Exception error) {
            Console.Error.WriteLine(error.ToString());
            return 1;
        } finally {
            if (external != null && !external.IsDisposed) external.Invoke(new Action(delegate { external.Close(); }));
            externalThread.Join(2000);
            if (original != IntPtr.Zero) SetForegroundWindow(original);
        }
    }
}
`);
    const compiler = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    execFileSync(compiler, ["/nologo", "/target:exe", "/main:ForegroundProbe", `/out:${executable}`,
      "/reference:System.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll", sourcePath, probePath],
    { windowsHide: true, timeout: 10000 });
    const output = execFileSync(executable, [], { windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.match(output, /FOREGROUND_PROBE_OK rounds=6 externalKeys=0 escapeKeys=0/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(directory)).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith("daisy-wechat-focus-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
