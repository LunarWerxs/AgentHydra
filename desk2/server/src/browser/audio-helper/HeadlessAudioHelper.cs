// One long-lived helper for Windows Core Audio: every ~750 ms it writes one JSON line with each audio session's pid,
// peak meter and mute state, and the Chrome processes' command lines when new ones appear; it mutes or unmutes the
// sessions of one pid when asked on stdin. Compiled once by headless-audio.ts (csc.exe) and started with no window.
//   out: {"t":<ms>,"s":[[pid,peak,muted],...],"p":[[pid,ppid,"cmd"],...]}   and {"r":"mute","pid":N,"n":K}
//   in:  {"op":"mute","pid":N,"on":true|false}   {"op":"quit"}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out int count); int Item(int index, out IMMDevice device); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int GetAudioSessionControl(IntPtr g, int f, out IntPtr c);
  int GetSimpleAudioVolume(IntPtr g, int f, out IntPtr v);
  int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int count); int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state);
  int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
  int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string v, ref Guid c);
  int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string p);
  int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string v, ref Guid c);
  int GetGroupingParam(out Guid g);
  int SetGroupingParam(ref Guid g, ref Guid c);
  int RegisterAudioSessionNotification(IntPtr n);
  int UnregisterAudioSessionNotification(IntPtr n);
  int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  int GetProcessId(out uint pid);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float peak); }
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  int SetMasterVolume(float l, ref Guid c);
  int GetMasterVolume(out float l);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid c);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}

static class Program {
  static readonly ConcurrentQueue<string> Commands = new ConcurrentQueue<string>();
  static readonly Regex PidRe = new Regex("\"pid\"\\s*:\\s*(\\d+)");
  static readonly Regex OnRe = new Regex("\"on\"\\s*:\\s*(true|false)");
  static readonly System.IO.Stream Stdout = Console.OpenStandardOutput();
  static readonly HashSet<int> Seen = new HashSet<int>();
  static DateTime lastProcs = DateTime.MinValue;

  static int Main() {
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) Commands.Enqueue(line);
      Commands.Enqueue("{\"op\":\"quit\"}");
    }) { IsBackground = true };
    reader.Start();
    var clock = Stopwatch.StartNew();
    while (true) {
      string cmd;
      while (Commands.TryDequeue(out cmd)) {
        if (cmd.Contains("\"quit\"")) return 0;
        if (cmd.Contains("\"mute\"")) Reply(cmd);
      }
      var sessions = Sessions();
      var sb = new StringBuilder();
      sb.Append("{\"t\":").Append(clock.ElapsedMilliseconds).Append(",\"s\":[");
      bool first = true;
      var unknown = false;
      foreach (var s in sessions) {
        if (!first) sb.Append(',');
        first = false;
        sb.Append('[').Append(s.Pid).Append(',').Append(s.Peak.ToString(System.Globalization.CultureInfo.InvariantCulture)).Append(',').Append(s.Muted ? "true" : "false").Append(']');
        if (!Seen.Contains((int)s.Pid)) unknown = true;
      }
      sb.Append(']');
      if (unknown || (DateTime.UtcNow - lastProcs).TotalSeconds > 30) {
        lastProcs = DateTime.UtcNow;
        foreach (var s in sessions) Seen.Add((int)s.Pid);
        sb.Append(",\"p\":[");
        bool pf = true;
        foreach (var p in ChromeProcesses()) {
          if (!pf) sb.Append(',');
          pf = false;
          sb.Append('[').Append(p.Key).Append(',').Append(p.Value.Item1).Append(",\"").Append(Escape(p.Value.Item2)).Append("\"]");
        }
        sb.Append(']');
      }
      sb.Append('}');
      Write(sb.ToString());
      Thread.Sleep(750);
    }
  }

  static void Reply(string cmd) {
    var pid = PidRe.Match(cmd);
    var on = OnRe.Match(cmd);
    if (!pid.Success || !on.Success) return;
    int n = SetMute(uint.Parse(pid.Groups[1].Value), on.Groups[1].Value == "true");
    Write("{\"r\":\"mute\",\"pid\":" + pid.Groups[1].Value + ",\"n\":" + n + "}");
  }

  static void Write(string line) {
    var bytes = Encoding.UTF8.GetBytes(line + "\n");
    Stdout.Write(bytes, 0, bytes.Length);
    Stdout.Flush();
  }

  static string Escape(string s) {
    if (s == null) return "";
    return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }

  struct Row { public uint Pid; public float Peak; public bool Muted; }

  static List<Row> Sessions() {
    var rows = new List<Row>();
    foreach (var s in All()) {
      var r = new Row();
      s.GetProcessId(out r.Pid);
      float p; ((IAudioMeterInformation)s).GetPeakValue(out p);
      r.Peak = p;
      bool m; ((ISimpleAudioVolume)s).GetMute(out m);
      r.Muted = m;
      rows.Add(r);
    }
    return rows;
  }

  static int SetMute(uint pid, bool mute) {
    int k = 0;
    var g = Guid.Empty;
    foreach (var s in All()) {
      uint p; s.GetProcessId(out p);
      if (p == pid) { ((ISimpleAudioVolume)s).SetMute(mute, ref g); k++; }
    }
    return k;
  }

  static List<IAudioSessionControl2> All() {
    var list = new List<IAudioSessionControl2>();
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCo();
    IMMDeviceCollection col; en.EnumAudioEndpoints(0, 1, out col);
    int n; col.GetCount(out n);
    var iid = typeof(IAudioSessionManager2).GUID;
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);
      IAudioSessionEnumerator se; ((IAudioSessionManager2)o).GetSessionEnumerator(out se);
      int c; se.GetCount(out c);
      for (int j = 0; j < c; j++) { IAudioSessionControl2 s; se.GetSession(j, out s); list.Add(s); }
    }
    return list;
  }

  static Dictionary<int, Tuple<int, string>> ChromeProcesses() {
    var found = new Dictionary<int, Tuple<int, string>>();
    try {
      using (var q = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE Name = 'chrome.exe'")) {
        foreach (ManagementObject o in q.Get()) {
          int pid = Convert.ToInt32(o["ProcessId"]);
          int ppid = Convert.ToInt32(o["ParentProcessId"]);
          var cmd = o["CommandLine"] as string ?? "";
          found[pid] = Tuple.Create(ppid, cmd);
        }
      }
    } catch (Exception) {
      // WMI can refuse for a moment; the next refresh asks again
    }
    return found;
  }
}
