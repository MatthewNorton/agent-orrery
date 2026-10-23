using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace Orrery {
    public static class TerminalFocus {
        public struct Owner { public int Pid; public long Start; }
        [StructLayout(LayoutKind.Sequential)]
        struct UniqueProcess { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Start; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ProcessInfo {
            public UniqueProcess Process;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string App;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
            public uint Type, Status, Session;
            [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
        }
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        static extern int RmStartSession(out uint handle, uint flags, StringBuilder key);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
        static extern int RmRegisterResources(uint handle, uint count, string[] files,
            uint apps, IntPtr processes, uint services, IntPtr serviceNames);
        [DllImport("rstrtmgr.dll")]
        static extern int RmGetList(uint handle, out uint needed, ref uint count,
            [In, Out] ProcessInfo[] processes, ref uint reasons);
        [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
        [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
        [DllImport("kernel32.dll")] static extern bool FreeConsole();
        [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern uint GetConsoleTitle(StringBuilder title, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetConsoleTitle(string title);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        delegate bool EnumWindow(IntPtr window, IntPtr unused);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr unused);

        public static Owner[] FileOwners(string file) {
            uint handle;
            if (RmStartSession(out handle, 0, new StringBuilder(33)) != 0) return new Owner[0];
            try {
                if (RmRegisterResources(handle, 1, new[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0)
                    return new Owner[0];
                uint needed, count = 0, reasons = 0;
                int result = RmGetList(handle, out needed, ref count, null, ref reasons);
                if (result != 234 || needed > 256) return new Owner[0];
                var entries = new ProcessInfo[needed];
                count = needed;
                if (RmGetList(handle, out needed, ref count, entries, ref reasons) != 0) return new Owner[0];
                var owners = new List<Owner>();
                for (int i = 0; i < count; i++) {
                    var entry = entries[i].Process;
                    owners.Add(new Owner { Pid = (int)entry.Pid,
                        Start = ((long)entry.Start.dwHighDateTime << 32) | (uint)entry.Start.dwLowDateTime });
                }
                return owners.ToArray();
            } finally { RmEndSession(handle); }
        }

        public static bool Matches(int pid, string provider, double startedAt, long fileTime) {
            try {
                using (var process = Process.GetProcessById(pid)) {
                    // A generic Node reader of a rollout is not evidence of an agent.
                    // Node-based CLIs need the provider's exact live-session registration.
                    if (process.ProcessName != provider && !(fileTime == 0 && process.ProcessName == "node")) return false;
                    var start = process.StartTime.ToUniversalTime();
                    if (fileTime != 0) return start.ToFileTimeUtc() == fileTime;
                    double age = startedAt - (start - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    return age >= 0 && age < 120000;
                }
            } catch { return false; }
        }

        static string Title() {
            var text = new StringBuilder(32768);
            GetConsoleTitle(text, (uint)text.Capacity);
            return text.ToString();
        }

        static bool IsTerminal(IntPtr window) {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            try {
                using (var process = Process.GetProcessById((int)pid))
                    return process.ProcessName.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase);
            } catch { return false; }
        }

        static bool Activate(IntPtr window) {
            if (IsIconic(window)) ShowWindow(window, 9); // SW_RESTORE only when minimized.
            SetForegroundWindow(window);
            // Another thread's window activates asynchronously; the foreground reads NULL until it lands.
            for (int i = 0; i < 20 && GetForegroundWindow() != window; i++) Thread.Sleep(25);
            return GetForegroundWindow() == window;
        }

        static AutomationElement FindPane(AutomationElement root, string marker) {
            // TerminalControl exposes its live title as HelpText, even for a renamed profile.
            // https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalControl/TermControlAutomationPeer.cpp
            return root.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"),
                new PropertyCondition(AutomationElement.HelpTextProperty, marker)));
        }

        static bool SelectPane(IntPtr window, string marker, DateTime deadline) {
            var root = AutomationElement.FromHandle(window);
            var tabs = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
            AutomationElement previous = null;
            bool selected = false;
            try {
                // Try the active pane first. A single-tab or focus-mode window may hide its tab strip.
                var pane = FindPane(root, marker);
                if (pane != null) {
                    if (!Activate(window)) return false;
                    pane.SetFocus();
                    selected = true;
                    return true;
                }
                for (int i = 0; i < tabs.Count; i++) {
                    object pattern;
                    if (tabs[i].TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern) &&
                        ((SelectionItemPattern)pattern).Current.IsSelected) previous = tabs[i];
                }
                // Inactive tab contents are absent from UIA. Select briefly to inspect pane identity;
                // restore the original tab if this window does not contain the exact console.
                for (int i = 0; i < Math.Min(tabs.Count, 64) && DateTime.UtcNow < deadline; i++) {
                    object pattern;
                    if (!tabs[i].TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) continue;
                    ((SelectionItemPattern)pattern).Select();
                    Thread.Sleep(40);
                    pane = FindPane(root, marker);
                    if (pane == null) continue;
                    if (!Activate(window)) return false;
                    pane.SetFocus();
                    selected = true;
                    return true;
                }
                return false;
            } finally {
                if (!selected && previous != null) {
                    object pattern;
                    if (previous.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
                        ((SelectionItemPattern)pattern).Select();
                }
            }
        }

        public static string Focus(int pid) {
            FreeConsole(); // Detach only this short-lived helper, never the agent.
            if (!AttachConsole((uint)pid)) return "NOT_FOUND";
            string original = null;
            string marker = "Orrery-focus-" + Guid.NewGuid().ToString("N");
            Timer restore = null;
            try {
                var console = GetConsoleWindow();
                if (console == IntPtr.Zero) return "NOT_FOUND";
                var owner = GetWindow(console, 4); // GW_OWNER: modern ConPTY's hosting HWND.
                if (owner == IntPtr.Zero && IsWindowVisible(console))
                    return Activate(console) ? "FOCUSED" : "NOT_FOUND";
                original = Title();
                // A fresh, temporary title proves pane identity; equal project names/titles never do.
                // No keystrokes, provider command, or input are sent to the console.
                if (!SetConsoleTitle(marker)) return "NOT_FOUND";
                // Restore even if a terminal's accessibility provider stalls until the
                // outer helper timeout. This timer touches only our unique temporary title.
                restore = new Timer(unused => {
                    if (Title() == marker) SetConsoleTitle(original);
                }, null, 7000, Timeout.Infinite);
                var deadline = DateTime.UtcNow.AddSeconds(6);
                Thread.Sleep(100);
                if (owner != IntPtr.Zero && IsTerminal(owner)) {
                    if (IsIconic(owner)) ShowWindow(owner, 9);
                    return SelectPane(owner, marker, deadline) ? "FOCUSED" : "NOT_FOUND";
                }
                var windows = new List<IntPtr>();
                EnumWindows((window, unused) => {
                    if (IsTerminal(window) && windows.Count < 32) windows.Add(window);
                    return true;
                }, IntPtr.Zero);
                foreach (var window in windows) {
                    if (DateTime.UtcNow >= deadline) break;
                    try { if (SelectPane(window, marker, deadline)) return "FOCUSED"; }
                    catch { /* closed or inaccessible terminal */ }
                }
                return "NOT_FOUND";
            } finally {
                if (restore != null) restore.Dispose();
                // Preserve a newer title written by the agent while the lookup was in flight.
                if (original != null && Title() == marker) SetConsoleTitle(original);
                FreeConsole();
            }
        }
    }
}
