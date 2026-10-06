// The dialog behind the folder menu's "Add new folder..." (SPEC "Folder picker"): Windows' own Select Folder
// dialog (the common item dialog, IFileOpenDialog with FOS_PICKFOLDERS). A page cannot learn a folder's full
// path, so the server shows the dialog: server/src/folders/pick.ts compiles this file once with the .NET
// Framework's csc.exe (with pick-folder.manifest: visual styles, per-monitor DPI) and runs it per click.
//
//   pick-folder.exe [--start <folder>] [--probe]
//
// Exit 0 prints the chosen folder on stdout (UTF-8); 1 = cancelled; 2 = failed, the reason on stderr.
// --start is the folder to open in while Windows remembers no last folder for this dialog. --probe sets the
// dialog up without showing it and prints --start back through its IShellItem (the server's tests).
//
// The window in front when this starts is the one just clicked. When that is Hydra Desk the dialog is owned
// by it: centred over it, kept above it, and able to take the foreground from it (an owned window shares its
// owner's input). The owner is enabled again as soon as the dialog shows, so a helper killed mid-dialog (the
// server's process tree stopped) never leaves the Hydra Desk window disabled.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace HydraDesk
{
    static class PickFolder
    {
        const uint FOS_NOCHANGEDIR = 0x8;
        const uint FOS_PICKFOLDERS = 0x20;
        const uint FOS_FORCEFILESYSTEM = 0x40;
        const uint FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const int HR_CANCELLED = unchecked((int)0x800704C7); // HRESULT_FROM_WIN32(ERROR_CANCELLED)

        // Fixed, so Windows keeps this dialog's last folder across new builds of this file.
        static readonly Guid ClientGuid = new Guid("6f7b2c1e-3d4a-4e8b-9c5d-1a2b3c4d5e6f");

        [STAThread]
        static int Main(string[] args)
        {
            string start = null;
            bool probe = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--start" && i + 1 < args.Length) start = args[++i];
                else if (args[i] == "--probe") probe = true;
            }
            try
            {
                return Run(start, probe);
            }
            catch (Exception e)
            {
                Write(Console.OpenStandardError(), e.Message);
                return 2;
            }
        }

        static int Run(string start, bool probe)
        {
            IFileDialog dialog = (IFileDialog)new FileOpenDialog();
            try
            {
                uint options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                Guid client = ClientGuid;
                dialog.SetClientGuid(ref client);
                dialog.SetTitle("Open folder");
                IShellItem folder = string.IsNullOrEmpty(start) ? null : ShellItem(start);
                if (folder != null) dialog.SetDefaultFolder(folder);
                if (probe)
                {
                    Write(Console.OpenStandardOutput(), folder == null ? "" : PathOf(folder));
                    return 0;
                }

                IntPtr owner = HydraDeskWindow();
                Raiser.Start(owner);
                int hr = dialog.Show(owner);
                Raiser.Stop();
                if (hr == HR_CANCELLED) return 1;
                Marshal.ThrowExceptionForHR(hr);
                IShellItem result;
                dialog.GetResult(out result);
                Write(Console.OpenStandardOutput(), PathOf(result));
                return 0;
            }
            finally
            {
                Marshal.FinalReleaseComObject(dialog);
            }
        }

        /** The window in front, when it is this app's (its title holds "AgentHydra": the window is named so, and a
            browser tab adds its own suffix). */
        static IntPtr HydraDeskWindow()
        {
            IntPtr front = GetForegroundWindow();
            if (front == IntPtr.Zero) return IntPtr.Zero;
            StringBuilder title = new StringBuilder(512);
            GetWindowText(front, title, title.Capacity);
            return title.ToString().Contains("AgentHydra") ? front : IntPtr.Zero;
        }

        /** The folder as a shell item; null when it is gone or cannot be parsed. */
        static IShellItem ShellItem(string path)
        {
            Guid iid = typeof(IShellItem).GUID;
            IShellItem item;
            return SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item) == 0 ? item : null;
        }

        static string PathOf(IShellItem item)
        {
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        }

        static void Write(Stream stream, string text)
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(text);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        // Once the dialog shows: enable its owner again and bring the dialog to the front. A thread timer, so
        // the dialog's own modal loop runs it.
        static class Raiser
        {
            static readonly TimerProc Tick = OnTick; // held here: native code calls it for the timer's life
            static UIntPtr timer;
            static IntPtr owner;
            static int ticks;

            public static void Start(IntPtr ownerWindow)
            {
                owner = ownerWindow;
                timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 30, Tick);
            }

            public static void Stop()
            {
                if (timer == UIntPtr.Zero) return;
                KillTimer(IntPtr.Zero, timer);
                timer = UIntPtr.Zero;
            }

            static void OnTick(IntPtr hwnd, uint msg, UIntPtr id, uint time)
            {
                IntPtr dialog = ShownWindow();
                if (dialog == IntPtr.Zero)
                {
                    if (++ticks > 300) Stop(); // about 9 s and still nothing shown: leave it be
                    return;
                }
                Stop();
                if (owner != IntPtr.Zero) EnableWindow(owner, true);
                Foreground(dialog, owner == IntPtr.Zero);
            }
        }

        static IntPtr shown;
        static readonly EnumWindowsProc Visit = VisitWindow;

        static bool VisitWindow(IntPtr hwnd, IntPtr unused)
        {
            if (!IsWindowVisible(hwnd)) return true;
            StringBuilder cls = new StringBuilder(16);
            GetClassName(hwnd, cls, cls.Capacity);
            if (cls.ToString() != "#32770") return true;
            shown = hwnd;
            return false;
        }

        /**
         * The dialog's window once it shows: this thread's visible dialog-class window. Not just any visible
         * window: the input indicator puts a visible overlay window (UAC_InputIndicatorOverlayWnd) here too.
         */
        static IntPtr ShownWindow()
        {
            shown = IntPtr.Zero;
            EnumThreadWindows(GetCurrentThreadId(), Visit, IntPtr.Zero);
            return shown;
        }

        /**
         * Brings the dialog to the front. Without an owner the dialog shares no input with the window in front,
         * so this thread joins that window's input for the call; Windows refuses the foreground otherwise.
         */
        static void Foreground(IntPtr dialog, bool attach)
        {
            IntPtr front = GetForegroundWindow();
            if (front == dialog) return;
            uint me = GetCurrentThreadId();
            uint pid;
            uint them = attach && front != IntPtr.Zero ? GetWindowThreadProcessId(front, out pid) : 0;
            bool attached = them != 0 && them != me && AttachThreadInput(me, them, true);
            try
            {
                BringWindowToTop(dialog);
                SetForegroundWindow(dialog);
            }
            finally
            {
                if (attached) AttachThreadInput(me, them, false);
            }
        }

        delegate void TimerProc(IntPtr hwnd, uint msg, UIntPtr id, uint time);
        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool EnableWindow(IntPtr hwnd, bool enable);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
        [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, TimerProc proc);
        [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, UIntPtr id);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    class FileOpenDialog { }

    // IModalWindow's Show, then IFileDialog's methods, in vtable order.
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filterSpecs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int placement);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
}
