// AgentHydra.exe, the Windows launcher at the top of a release bundle (docs/RELEASING.md, "The launcher").
// It ships no Bun: it makes sure the folder holds every part of its own version, makes sure runtime\bun.exe is
// the Bun this release pins (downloading it on first run), then runs `bun.exe app\server.js` with every
// argument and passes the exit code through. Written for the .NET Framework 4 C# compiler every Windows
// 10 and 11 ships (C# 5: no interpolated strings, no `?.`), compiled by scripts/build-launcher.ts, which
// writes the version into BuildInfo.cs.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AgentHydra
{
    /// <summary>A failure with a message fit for the person at the PC: shown as is.</summary>
    sealed class LauncherException : Exception
    {
        public LauncherException(string message) : base(message) { }
    }

    static class Program
    {
        const string ReleaseHost = "https://github.com/LunarWerxs/AgentHydra/releases/download";
        const string BunHost = "https://github.com/oven-sh/bun/releases/download";
        const string Target = "windows-x64";

        // What a complete install holds. A missing one is restored from the release archive.
        static readonly string[] RequiredParts =
        {
            "app\\server.js", "app\\release.json", "app\\bun-version", "desk2", "orchestrator", "misc"
        };

        static bool uiAllowed;
        static ProgressWindow progress;
        static long lastReport;

        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                // .NET 4 defaults to SSL 3 and TLS 1.0, which GitHub refuses.
                ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072;
            }
            catch (Exception) { }

            uiAllowed = InteractiveUi();
            try
            {
                if (args.Length > 0 && args[0] == "--version")
                {
                    WriteLine(false, BuildInfo.Version);
                    return 0;
                }
                string install = InstallDir();
                string bun = EnsureAll(install);
                if (args.Length > 0 && args[0] == "--ensure-bun")
                {
                    WriteLine(false, bun);
                    return 0;
                }
                return RunDaemon(bun, Path.Combine(install, "app", "server.js"), args);
            }
            catch (Exception e)
            {
                string message = e is LauncherException ? e.Message : e.GetType().Name + ": " + e.Message;
                Log("failure: " + message);
                CloseProgress();
                WriteLine(true, message);
                if (uiAllowed)
                {
                    try { MessageBox.Show(message, "AgentHydra", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                    catch (Exception) { }
                }
                return 1;
            }
        }

        static string InstallDir()
        {
            return Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        }

        // ---- the install: repair, then Bun -----------------------------------------------------------

        static bool Exists(string path)
        {
            return File.Exists(path) || Directory.Exists(path);
        }

        static List<string> MissingParts(string install)
        {
            List<string> missing = new List<string>();
            foreach (string part in RequiredParts)
                if (!Exists(Path.Combine(install, part))) missing.Add(part);
            return missing;
        }

        /// <summary>Runs steps 3 and 4: the path of the Bun to run, with every part of the install in place.</summary>
        static string EnsureAll(string install)
        {
            // The common start touches the disk a few times and takes no lock.
            if (MissingParts(install).Count == 0)
            {
                string ready = CurrentBun(install, ReadPin(install));
                if (ready != null) return ready;
            }

            Mutex mutex = Acquire(install);
            try
            {
                // A launcher that held the lock before us may have done everything already.
                Repair(install);
                string pin = ReadPin(install);
                return CurrentBun(install, pin) ?? InstallBun(install, pin);
            }
            finally
            {
                CloseProgress();
                mutex.ReleaseMutex();
                mutex.Dispose();
            }
        }

        static Mutex Acquire(string install)
        {
            string key = Path.GetFullPath(install).TrimEnd('\\').ToLowerInvariant();
            string name;
            using (SHA256 sha = SHA256.Create())
                name = "Local\\AgentHydra-Launcher-" + Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(key))).Substring(0, 24);
            Mutex mutex = new Mutex(false, name);
            try
            {
                if (!mutex.WaitOne(TimeSpan.FromMinutes(15)))
                    throw new LauncherException("another AgentHydra launcher has been downloading into " + install + " for over 15 minutes");
            }
            catch (AbandonedMutexException)
            {
                // The launcher that held it died mid-download; its temp folder is cleaned below and we own the lock now.
            }
            return mutex;
        }

        static string ReadPin(string install)
        {
            string file = Path.Combine(install, "app", "bun-version");
            if (!File.Exists(file)) throw new LauncherException("app\\bun-version is missing from " + install);
            string pin = File.ReadAllText(file).Trim();
            // The pin goes into a URL: nothing but a version's own characters.
            if (!Regex.IsMatch(pin, @"^[0-9A-Za-z][0-9A-Za-z.+\-]*$"))
                throw new LauncherException("app\\bun-version does not hold a Bun version");
            return pin;
        }

        static string CurrentBun(string install, string pin)
        {
            string runtime = Path.Combine(install, "runtime");
            string bun = Path.Combine(runtime, "bun.exe");
            string stamp = Path.Combine(runtime, "bun.version");
            if (!File.Exists(bun) || !File.Exists(stamp)) return null;
            return File.ReadAllText(stamp).Trim() == pin ? bun : null;
        }

        static string Base(string variable, string fallback)
        {
            string value = Environment.GetEnvironmentVariable(variable);
            return (string.IsNullOrWhiteSpace(value) ? fallback : value.Trim()).TrimEnd('/');
        }

        static string Random()
        {
            return Guid.NewGuid().ToString("N").Substring(0, 8);
        }

        /// <summary>Restores what is missing from this version's release archive; a part that is there is never touched.</summary>
        static void Repair(string install)
        {
            List<string> missing = MissingParts(install);
            if (missing.Count == 0) return;

            string name = "AgentHydra-" + BuildInfo.Version + "-" + Target;
            string baseUrl = Base("AGENTHYDRA_RELEASE_BASE", ReleaseHost) + "/v" + BuildInfo.Version + "/";
            string work = Path.Combine(install, ".repair-" + Random());
            Directory.CreateDirectory(work);
            try
            {
                string zip = Path.Combine(work, name + ".zip");
                Fetch(baseUrl + name + ".zip", zip, "Downloading AgentHydra " + BuildInfo.Version);
                VerifyHash(zip, name + ".zip", FetchText(baseUrl + "SHA256SUMS.txt"));

                string unpacked = Path.Combine(work, "unpacked");
                ExtractAll(zip, unpacked);
                string root = ArchiveRoot(unpacked);

                // Whole top-level parts first (a missing desk2\ comes back with everything in it), then the
                // single files of a part that is there (app\ kept, app\server.js lost).
                foreach (string entry in Directory.GetFileSystemEntries(root))
                {
                    string top = Path.GetFileName(entry);
                    string target = Path.Combine(install, top);
                    if (top.Equals("runtime", StringComparison.OrdinalIgnoreCase) || Exists(target)) continue;
                    MoveEntry(entry, target);
                }
                foreach (string part in RequiredParts)
                {
                    string target = Path.Combine(install, part);
                    string source = Path.Combine(root, part);
                    if (Exists(target)) continue;
                    if (!Exists(source)) throw new LauncherException("the release archive " + name + ".zip has no " + part);
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    MoveEntry(source, target);
                }
            }
            finally
            {
                TryDelete(work);
            }
        }

        static void MoveEntry(string source, string target)
        {
            if (Directory.Exists(source)) Directory.Move(source, target);
            else File.Move(source, target);
        }

        /// <summary>The bundle folder inside the archive (AgentHydra-x.y.z-windows-x64\), or the unpack folder itself.</summary>
        static string ArchiveRoot(string unpacked)
        {
            if (Directory.Exists(Path.Combine(unpacked, "app"))) return unpacked;
            string[] folders = Directory.GetDirectories(unpacked);
            return folders.Length == 1 ? folders[0] : unpacked;
        }

        static string InstallBun(string install, string pin)
        {
            string runtime = Path.Combine(install, "runtime");
            Directory.CreateDirectory(runtime);
            foreach (string stale in Directory.GetDirectories(runtime, ".new-*")) TryDelete(stale);

            // The baseline build runs on CPUs without AVX2 (PF_AVX2_INSTRUCTIONS_AVAILABLE).
            string asset = "bun-windows-x64" + (IsProcessorFeaturePresent(40) ? "" : "-baseline") + ".zip";
            string baseUrl = Base("AGENTHYDRA_BUN_BASE", BunHost) + "/bun-v" + pin + "/";
            string work = Path.Combine(runtime, ".new-" + Random());
            Directory.CreateDirectory(work);
            string bun = Path.Combine(runtime, "bun.exe");
            try
            {
                string zip = Path.Combine(work, asset);
                Fetch(baseUrl + asset, zip, "Downloading Bun " + pin);
                VerifyHash(zip, asset, FetchText(baseUrl + "SHASUMS256.txt"));
                string fresh = Path.Combine(work, "bun.exe");
                ExtractOne(zip, "bun.exe", fresh);

                // A running bun.exe can be renamed but never overwritten. The stamp goes first and comes back
                // last, so a swap that dies half way is redone by the next start.
                string stamp = Path.Combine(runtime, "bun.version");
                File.Delete(stamp);
                string aside = null;
                if (File.Exists(bun))
                {
                    aside = bun + ".old-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                    File.Move(bun, aside);
                }
                try
                {
                    File.Move(fresh, bun);
                }
                catch (Exception)
                {
                    if (aside != null && !File.Exists(bun)) File.Move(aside, bun);
                    throw;
                }
                File.WriteAllText(stamp, pin + "\r\n");
            }
            finally
            {
                TryDelete(work);
            }
            // Renamed-aside copies still running refuse to go; the next swap takes them.
            foreach (string old in Directory.GetFiles(runtime, "bun.exe.old-*")) TryDelete(old);
            return bun;
        }

        // ---- downloads, hashes, archives ---------------------------------------------------------------

        static void Fetch(string url, string file, string what)
        {
            using (FileStream dest = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.None))
                Fetch(url, dest, what);
        }

        static string FetchText(string url)
        {
            using (MemoryStream dest = new MemoryStream())
            {
                Fetch(url, dest, "Checking the download");
                return Encoding.UTF8.GetString(dest.ToArray());
            }
        }

        static void Fetch(string url, Stream dest, string what)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.UserAgent = "AgentHydra-Launcher/" + BuildInfo.Version;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 60000;
            if (request.Proxy != null) request.Proxy.Credentials = CredentialCache.DefaultCredentials;
            try
            {
                using (WebResponse response = request.GetResponse())
                using (Stream source = response.GetResponseStream())
                {
                    long total = response.ContentLength;
                    long got = 0;
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        dest.Write(buffer, 0, read);
                        got += read;
                        Report(what, got, total);
                    }
                    if (total >= 0 && got != total)
                        throw new LauncherException("could not download " + url + ": the connection ended after " + got + " of " + total + " bytes");
                    Log("download " + url + " " + got + " bytes");
                }
            }
            catch (WebException e)
            {
                throw new LauncherException("could not download " + url + ": " + e.Message);
            }
            catch (IOException e)
            {
                throw new LauncherException("could not download " + url + ": " + e.Message);
            }
        }

        static string Sha256OfFile(string file)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(file))
                return Hex(sha.ComputeHash(stream));
        }

        static string Hex(byte[] bytes)
        {
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        /// <summary>Checks the file against its line in a sha256sum-style list (hash, spaces, optional *, path). Only the file name
        /// of the path counts: release.yml writes the release's list with `sha256sum out/*`, so its lines read `out/AgentHydra-...zip`.</summary>
        static void VerifyHash(string file, string asset, string sums)
        {
            string expected = null;
            foreach (string line in sums.Split('\n'))
            {
                Match m = Regex.Match(line.Trim(), @"^([0-9a-fA-F]{64})\s+\*?(?:\./)?(.+)$");
                if (m.Success && Path.GetFileName(m.Groups[2].Value.Trim()) == asset)
                {
                    expected = m.Groups[1].Value.ToLowerInvariant();
                    break;
                }
            }
            if (expected == null) throw new LauncherException("the checksum list has no line for " + asset + ", so it was not used");
            string actual = Sha256OfFile(file);
            if (actual != expected)
                throw new LauncherException("the SHA-256 of " + asset + " is " + actual + ", not the " + expected + " its checksum list gives, so it was not used");
        }

        static string EntryPath(string root, ZipArchiveEntry entry)
        {
            // Compress-Archive on Windows PowerShell 5 writes backslashes.
            string relative = entry.FullName.Replace('/', '\\');
            string full = Path.GetFullPath(Path.Combine(root, relative));
            string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
            if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                throw new LauncherException("the archive holds a file outside its folder (" + entry.FullName + "), so it was not used");
            return full;
        }

        static void ExtractAll(string zip, string root)
        {
            Directory.CreateDirectory(root);
            using (ZipArchive archive = ZipFile.OpenRead(zip))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string path = EntryPath(root, entry);
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(path);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    entry.ExtractToFile(path, true);
                }
            }
        }

        static void ExtractOne(string zip, string fileName, string dest)
        {
            using (ZipArchive archive = ZipFile.OpenRead(zip))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    if (entry.Name == fileName)
                    {
                        entry.ExtractToFile(dest, true);
                        return;
                    }
                }
            }
            throw new LauncherException("the archive " + Path.GetFileName(zip) + " holds no " + fileName);
        }

        static void TryDelete(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
                else if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception) { }
        }

        // ---- running the daemon ------------------------------------------------------------------------

        /// <summary>Appends one argument the way CommandLineToArgvW (and so Bun and Node) reads it back.</summary>
        internal static void AppendArg(StringBuilder sb, string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                sb.Append(arg);
                return;
            }
            sb.Append('"');
            int i = 0;
            while (true)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\')
                {
                    i++;
                    backslashes++;
                }
                if (i == arg.Length)
                {
                    // Backslashes before the closing quote are doubled so they do not escape it.
                    sb.Append('\\', backslashes * 2);
                    break;
                }
                if (arg[i] == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(arg[i]);
                }
                i++;
            }
            sb.Append('"');
        }

        static IntPtr StdFor(int which, bool input, List<IntPtr> opened)
        {
            IntPtr handle = GetStdHandle(which);
            if (IsMissing(handle))
            {
                // Started from Explorer: the daemon still wants three open handles, so it gets NUL.
                handle = CreateFile("NUL", input ? 0x80000000 : 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                if (handle == new IntPtr(-1)) throw new LauncherException("could not open NUL for the daemon's standard handles");
                opened.Add(handle);
            }
            // CreateProcess hands a handle on only when it is inheritable.
            SetHandleInformation(handle, 1, 1);
            return handle;
        }

        static int RunDaemon(string bun, string server, string[] args)
        {
            StringBuilder commandLine = new StringBuilder();
            AppendArg(commandLine, bun);
            commandLine.Append(' ');
            AppendArg(commandLine, server);
            foreach (string arg in args)
            {
                commandLine.Append(' ');
                AppendArg(commandLine, arg);
            }

            // Closing the job (the launcher dying included) kills the daemon. SILENT_BREAKAWAY_OK keeps what the
            // daemon starts out of the job: Desk 2 and the chat hosts outlive the daemon on purpose.
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Win32Failure("CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x1000;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr block = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, block, false);
                if (!SetInformationJobObject(job, 9, block, (uint)size)) throw Win32Failure("SetInformationJobObject");
            }
            finally
            {
                Marshal.FreeHGlobal(block);
            }

            List<IntPtr> opened = new List<IntPtr>();
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = 0x100; // STARTF_USESTDHANDLES: the MCP client on the other end of our pipes talks to the daemon
            startup.hStdInput = StdFor(-10, true, opened);
            startup.hStdOutput = StdFor(-11, false, opened);
            startup.hStdError = StdFor(-12, false, opened);

            PROCESS_INFORMATION process;
            // CREATE_NO_WINDOW | CREATE_SUSPENDED: no console, and not a line of the daemon runs before it is in the job.
            if (!CreateProcess(bun, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x4, IntPtr.Zero, null, ref startup, out process))
                throw Win32Failure("could not start " + bun);
            if (!AssignProcessToJobObject(job, process.hProcess))
            {
                TerminateProcess(process.hProcess, 1);
                throw Win32Failure("AssignProcessToJobObject");
            }
            ResumeThread(process.hThread);
            CloseHandle(process.hThread);
            WaitForSingleObject(process.hProcess, 0xFFFFFFFF);
            uint code;
            GetExitCodeProcess(process.hProcess, out code);
            CloseHandle(process.hProcess);
            foreach (IntPtr handle in opened) CloseHandle(handle);
            CloseHandle(job);
            return unchecked((int)code);
        }

        static LauncherException Win32Failure(string what)
        {
            return new LauncherException(what + " failed: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
        }

        // ---- output, the log, the progress window ------------------------------------------------------

        static bool IsMissing(IntPtr handle)
        {
            return handle == IntPtr.Zero || handle == new IntPtr(-1);
        }

        /// <summary>The window and the message box show only when nobody is scripting this run: not headless, stdout not redirected.</summary>
        static bool InteractiveUi()
        {
            if (Environment.GetEnvironmentVariable("AGENTHYDRA_HEADLESS") == "1") return false;
            IntPtr stdout = GetStdHandle(-11);
            if (IsMissing(stdout)) return true;
            uint mode;
            return GetConsoleMode(stdout, out mode);
        }

        /// <summary>A GUI-subsystem exe has no stdout of its own in a terminal: borrow the parent's console for the line.</summary>
        static void WriteLine(bool error, string text)
        {
            try
            {
                IntPtr stdout = GetStdHandle(-11);
                IntPtr stderr = GetStdHandle(-12);
                if ((IsMissing(stdout) || IsMissing(stderr)) && AttachConsole(0xFFFFFFFF))
                {
                    IntPtr console = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                    if (console != new IntPtr(-1))
                    {
                        if (IsMissing(stdout)) SetStdHandle(-11, console);
                        if (IsMissing(stderr)) SetStdHandle(-12, console);
                    }
                }
                Stream stream = error ? Console.OpenStandardError() : Console.OpenStandardOutput();
                byte[] bytes = new UTF8Encoding(false).GetBytes(text + "\r\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }
            catch (Exception) { }
        }

        /// <summary>launcher.log sits with the daemon's own logs: run-logs\ in its data folder (server/src/config.ts).</summary>
        static string LogDir()
        {
            Func<string, string> env = delegate(string suffix)
            {
                string value = Environment.GetEnvironmentVariable("AGENTHYDRA_" + suffix);
                if (value == null) value = Environment.GetEnvironmentVariable("CCMANAGERUI_" + suffix);
                return value == null ? "" : value.Trim();
            };
            if (env("RUN_LOG_DIR").Length > 0) return env("RUN_LOG_DIR");
            string data = env("DATA_DIR");
            if (data.Length == 0)
            {
                string config = env("HOME");
                if (config.Length == 0)
                {
                    string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                    string preferred = Path.Combine(home, ".agenthydra");
                    string legacy = Path.Combine(home, ".ccmanagerui");
                    config = !Directory.Exists(preferred) && Directory.Exists(legacy) ? legacy : preferred;
                }
                data = Path.Combine(config, "data");
            }
            return Path.Combine(data, "run-logs");
        }

        static void Log(string line)
        {
            string text = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") + " launcher " + BuildInfo.Version + " "
                + line.Replace("\r", " ").Replace("\n", " ") + "\r\n";
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    string dir = LogDir();
                    Directory.CreateDirectory(dir);
                    File.AppendAllText(Path.Combine(dir, "launcher.log"), text, new UTF8Encoding(false));
                    return;
                }
                catch (Exception)
                {
                    // Another launcher is writing the same line of history; try again shortly.
                    Thread.Sleep(50);
                }
            }
        }

        static void Report(string what, long done, long total)
        {
            if (!uiAllowed) return;
            long now = Environment.TickCount;
            if (progress != null && done != total && now - lastReport < 100) return;
            lastReport = now;
            try
            {
                if (progress == null) progress = ProgressWindow.Open();
                progress.Report(what, done, total);
            }
            catch (Exception)
            {
                uiAllowed = false;
            }
        }

        static void CloseProgress()
        {
            if (progress == null) return;
            try { progress.Close(); }
            catch (Exception) { }
            progress = null;
        }

        // ---- Win32 ---------------------------------------------------------------------------------------

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public int dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int which, IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint processId);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] static extern bool IsProcessorFeaturePresent(uint feature);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity,
            bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    }

    /// <summary>The small window shown while something downloads; it lives on a thread of its own.</summary>
    sealed class ProgressWindow
    {
        Form form;
        Label label;
        ProgressBar bar;
        Thread thread;

        public static ProgressWindow Open()
        {
            ProgressWindow window = new ProgressWindow();
            ManualResetEvent shown = new ManualResetEvent(false);
            window.thread = new Thread(delegate()
            {
                Application.EnableVisualStyles();
                window.form = new Form();
                window.form.Text = "AgentHydra";
                window.form.FormBorderStyle = FormBorderStyle.FixedDialog;
                window.form.ControlBox = false;
                window.form.MaximizeBox = false;
                window.form.MinimizeBox = false;
                window.form.StartPosition = FormStartPosition.CenterScreen;
                window.form.TopMost = true;
                window.form.ClientSize = new Size(420, 84);
                try { window.form.Icon = Icon.ExtractAssociatedIcon(System.Reflection.Assembly.GetExecutingAssembly().Location); }
                catch (Exception) { }
                window.label = new Label();
                window.label.AutoSize = false;
                window.label.SetBounds(16, 12, 388, 20);
                window.label.Text = "Preparing AgentHydra...";
                window.bar = new ProgressBar();
                window.bar.SetBounds(16, 40, 388, 22);
                window.bar.Style = ProgressBarStyle.Marquee;
                window.form.Controls.Add(window.label);
                window.form.Controls.Add(window.bar);
                window.form.Shown += delegate { shown.Set(); };
                Application.Run(window.form);
            });
            window.thread.SetApartmentState(ApartmentState.STA);
            window.thread.IsBackground = true;
            window.thread.Start();
            shown.WaitOne(10000);
            return window;
        }

        public void Report(string text, long done, long total)
        {
            if (form == null || !form.IsHandleCreated) return;
            form.BeginInvoke((MethodInvoker)delegate
            {
                label.Text = total > 0
                    ? text + " (" + (done / 1048576) + " of " + (total / 1048576) + " MB)"
                    : text + "...";
                if (total > 0)
                {
                    bar.Style = ProgressBarStyle.Continuous;
                    bar.Value = (int)Math.Min(100, done * 100 / total);
                }
            });
        }

        public void Close()
        {
            if (form != null && form.IsHandleCreated) form.BeginInvoke((MethodInvoker)delegate { form.Close(); });
            thread.Join(3000);
        }
    }
}
