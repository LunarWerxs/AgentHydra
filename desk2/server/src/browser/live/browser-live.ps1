# browser_live engine: drives the human's OWN open Chrome/Edge/Brave windows on this PC through
# Windows UI Automation. It stays up for its MCP process: one JSON request per stdin line, one JSON answer per
# stdout line. No debug port, no add-on, nothing leaves this machine.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
[Console]::InputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing, System.Windows.Forms

$liveSrc = @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
using System.Text.RegularExpressions; using System.Windows.Automation;
[StructLayout(LayoutKind.Sequential, Pack=4)] public struct LivePKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit, Size=24)] public struct LivePV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ILivePropStore { [PreserveSig] int GetCount(out uint c); [PreserveSig] int GetAt(uint i, out LivePKey k); [PreserveSig] int GetValue(ref LivePKey k, out LivePV v); [PreserveSig] int SetValue(ref LivePKey k, ref LivePV v); [PreserveSig] int Commit(); }
public class LiveWinInfo { public long Hwnd; public uint Pid; public int Z; public string Title; public bool Front; }
public static class LiveWin {
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out ILivePropStore s);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref LivePV v);
  // A window's AppUserModel property: pid 2 is the relaunch command (Chrome writes --profile-directory
  // into it), 4 the relaunch display name ("Example Owner - Chrome"), 5 the app id.
  public static string Prop(IntPtr h, uint pid) {
    try {
      var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); ILivePropStore s;
      if (SHGetPropertyStoreForWindow(h, ref iid, out s) != 0 || s == null) return "";
      var k = new LivePKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = pid }; LivePV v; string r = "";
      if (s.GetValue(ref k, out v) == 0) { if (v.vt == 31 && v.p != IntPtr.Zero) r = Marshal.PtrToStringUni(v.p); PropVariantClear(ref v); }
      Marshal.ReleaseComObject(s); return r;
    } catch { return ""; }
  }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint size);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int retLen);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static List<IntPtr> TopWindows() { var r = new List<IntPtr>(); EnumWindows(delegate(IntPtr h, IntPtr l) { if (IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static string Text(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  // Every visible titled Chromium top-level window, in z order (z counts every visible window, as before).
  public static List<LiveWinInfo> Candidates() {
    var r = new List<LiveWinInfo>(); IntPtr fg = GetForegroundWindow(); int z = 0;
    foreach (IntPtr h in TopWindows()) {
      z++;
      if (Cls(h) != "Chrome_WidgetWin_1") continue;
      string t = Text(h); if (t.Length == 0) continue;
      r.Add(new LiveWinInfo { Hwnd = h.ToInt64(), Pid = Pid(h), Z = z, Title = t, Front = h == fg });
    }
    return r;
  }
  // The executable a process runs, "" when it cannot be opened.
  public static string ImagePath(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
    try { var s = new StringBuilder(1024); uint n = (uint)s.Capacity; return QueryFullProcessImageName(h, 0, s, ref n) ? s.ToString() : ""; }
    finally { CloseHandle(h); }
  }
  // The command line a process was started with (ProcessCommandLineInformation, Windows 8.1+), null when it cannot
  // be read: one call where a WMI query took hundreds of milliseconds.
  public static string CommandLine(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return null;
    try {
      int len; NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len); if (len <= 0) return null;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
        int bytes = (ushort)Marshal.ReadInt16(buf); IntPtr p = Marshal.ReadIntPtr(buf, IntPtr.Size);
        return p == IntPtr.Zero ? "" : Marshal.PtrToStringUni(p, bytes / 2);
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(h); }
  }
  // The Alt tap that lets SetForegroundWindow through goes to whichever window is in front; sent to the browser itself
  // it moves focus to the browser's menu button, the field on the page blurs, and a chip box drops its text (2026-10-02).
  // So a window already in front gets no tap, and the tap is the fallback, never the first try.
  public static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  public static void Click(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60); SetCursorPos(old.X, old.Y);
  }
}

public class LiveOutline { public List<string> Lines = new List<string>(); public List<string> Refs = new List<string>(); public List<string> Marks = new List<string>(); public bool Truncated; public int Visited; }
public class LiveChrome { public AutomationElement Root; public List<AutomationElement> Tabs = new List<AutomationElement>(); public AutomationElement Address; public AutomationElement Doc; public int Seen; }

// The page and the browser's own frame, read through cache requests. A ref is the child-index path from the page's
// Document in the control view, exactly as the TreeWalker.ControlViewWalker walk numbered it.
public static class LiveTree {
  static readonly string[] Interactive = { "button", "hyperlink", "edit", "checkbox", "radiobutton", "combobox", "menuitem", "tabitem", "slider", "spinner", "splitbutton", "treeitem", "dataitem" };
  static readonly string[] OptionRoles = { "listitem", "menuitem", "dataitem", "treeitem" };
  static readonly Regex Wordy = new Regex(@"[\p{L}\p{N}]");
  static readonly Regex CreateLabel = new Regex(@"^(create|add)\s*:?\s*[""'“‘]?(.*?)[""'”’]?$", RegexOptions.IgnoreCase);
  static CacheRequest treeReq, kidsReq, oneReq, chromeReq, namesReq;

  // No value is cached: a field's value is read only for an edit or combobox that is not a password field.
  static CacheRequest Make(TreeScope scope, bool chrome, bool namesOnly = false) {
    var cr = new CacheRequest();
    cr.TreeFilter = Automation.ControlViewCondition;
    cr.TreeScope = scope;
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    if (namesOnly) return cr;
    if (chrome) {
      cr.Add(AutomationElement.IsOffscreenProperty);
      cr.Add(AutomationElement.BoundingRectangleProperty);
      cr.Add(AutomationElement.RuntimeIdProperty);
      cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
      cr.Add(SelectionItemPattern.IsSelectedProperty);
    } else {
      cr.Add(AutomationElement.IsEnabledProperty);
      cr.Add(AutomationElement.IsPasswordProperty);
      cr.Add(AutomationElement.HasKeyboardFocusProperty);
      cr.Add(AutomationElement.IsKeyboardFocusableProperty);
      cr.Add(AutomationElement.IsTogglePatternAvailableProperty);
      cr.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
      cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
      cr.Add(TogglePattern.ToggleStateProperty);
      cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
    }
    return cr;
  }
  static CacheRequest TreeReq { get { if (treeReq == null) treeReq = Make(TreeScope.Subtree, false); return treeReq; } }
  static CacheRequest KidsReq { get { if (kidsReq == null) kidsReq = Make(TreeScope.Element | TreeScope.Children, false); return kidsReq; } }
  static CacheRequest OneReq { get { if (oneReq == null) oneReq = Make(TreeScope.Element, false); return oneReq; } }
  static CacheRequest ChromeReq { get { if (chromeReq == null) chromeReq = Make(TreeScope.Element | TreeScope.Children, true); return chromeReq; } }

  static CacheRequest NamesReq { get { if (namesReq == null) namesReq = Make(TreeScope.Subtree, false, true); return namesReq; } }

  // The subtree with everything an outline line shows, in one call.
  public static AutomationElement Snapshot(AutomationElement el) { return el.GetUpdatedCache(TreeReq); }
  // The subtree with only names and roles, for a search by name: lighter for the browser to answer.
  public static AutomationElement Names(AutomationElement el) { return el.GetUpdatedCache(NamesReq); }
  // A node fetched without children (a leaf of the walk) has none to give.
  static AutomationElementCollection Kids(AutomationElement el) { try { return el.CachedChildren; } catch (InvalidOperationException) { return null; } }
  // A cached fact, or null when this element was fetched without it or does not support it.
  static object Get(AutomationElement el, AutomationProperty p) { try { object v = el.GetCachedPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; } catch (InvalidOperationException) { return null; } }
  // A live fact, or null when the element has left the page.
  static object Live(AutomationElement el, AutomationProperty p) { try { object v = el.GetCurrentPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; } catch (ElementNotAvailableException) { return null; } }
  static object Fact(AutomationElement el, AutomationProperty p) { return Get(el, p) ?? Live(el, p); }
  static bool Flag(AutomationElement el, AutomationProperty p) { object v = Get(el, p); return v is bool && (bool)v; }

  public static string Role(AutomationElement el) {
    var ct = Fact(el, AutomationElement.ControlTypeProperty) as ControlType;
    string n = ct == null ? "" : (ct.ProgrammaticName ?? "");
    if (n.StartsWith("ControlType.")) n = n.Substring(12);
    return n.ToLowerInvariant();
  }
  public static string Name(AutomationElement el) { return (Fact(el, AutomationElement.NameProperty) as string) ?? ""; }
  // Pages pad labels with zero-width spaces and byte-order marks; they are noise to a reader.
  public static string Clean(string s) { return (s ?? "").Replace("​", "").Replace("﻿", "").Trim(); }
  public static bool IsSelected(AutomationElement el) { if (el == null) return false; return Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty) && Flag(el, SelectionItemPattern.IsSelectedProperty); }
  public static string Rid(AutomationElement el) {
    var id = Fact(el, AutomationElement.RuntimeIdProperty) as int[];
    if (id == null) return "";
    var parts = new string[id.Length]; for (int i = 0; i < id.Length; i++) parts[i] = id[i].ToString();
    return string.Join(".", parts);
  }
  // A text value through the Value pattern, null when there is none or the element has left the page. Never called
  // for a password field.
  static string TextValue(AutomationElement el) {
    if (el == null) return null;
    try { object p; return el.TryGetCurrentPattern(ValuePattern.Pattern, out p) ? (((ValuePattern)p).Current.Value ?? "") : null; } catch (ElementNotAvailableException) { return null; }
  }
  // The address bar's text (the page's URL).
  public static string Value(AutomationElement el) { return TextValue(el) ?? ""; }

  static string Line(AutomationElement el, string r, string role, string name) {
    if (name.Length > 200) name = name.Substring(0, 200) + "...";
    var bits = new List<string>();
    object enabled = Get(el, AutomationElement.IsEnabledProperty);
    if (enabled is bool && !(bool)enabled) bits.Add("disabled");
    string val = null;
    if (role == "edit" || role == "combobox") {
      // The value is read only once the field is known NOT to be a password field.
      object pw = Fact(el, AutomationElement.IsPasswordProperty);
      if (pw is bool && (bool)pw) bits.Add("password");
      else if (pw is bool) { val = TextValue(el); if (val != null && val.Length > 200) val = val.Substring(0, 200) + "..."; }
    }
    if (Flag(el, AutomationElement.IsTogglePatternAvailableProperty)) { object ts = Get(el, TogglePattern.ToggleStateProperty); if (ts != null) bits.Add(ts.ToString().ToLowerInvariant()); }
    if (role != "hyperlink" && Flag(el, AutomationElement.IsExpandCollapsePatternAvailableProperty)) { object es = Get(el, ExpandCollapsePattern.ExpandCollapseStateProperty); if (es != null) bits.Add(es.ToString().ToLowerInvariant()); }
    if (Flag(el, AutomationElement.HasKeyboardFocusProperty)) bits.Add("focused");
    var sb = new StringBuilder("[" + r + "] " + role);
    if (name.Length > 0) sb.Append(" \"" + name + "\"");
    if (!string.IsNullOrEmpty(val)) sb.Append(" = \"" + val + "\"");
    if (bits.Count > 0) sb.Append(" (" + string.Join(", ", bits) + ")");
    return sb.ToString();
  }
  // One element's line as it stands now (one call), e.g. after a click changed it.
  public static string LineOf(AutomationElement el, string r) {
    try { var c = el.GetUpdatedCache(OneReq); return Line(c, r, Role(c), Clean(Name(c))); } catch (ElementNotAvailableException) { return "[" + r + "] (gone)"; } catch (Exception) { return "[" + r + "] (changed)"; }
  }
  static string Mark(string role, string name) { return name.Length > 0 ? role + " \"" + name + "\"" : role; }
  static bool Matches(string name, string[] find) {
    foreach (string f in find) if (!string.IsNullOrEmpty(f) && name.IndexOf(f, StringComparison.OrdinalIgnoreCase) >= 0) return true;
    return false;
  }

  // The outline: interactive elements, and wordy text, images and headers, depth first in page order.
  public static LiveOutline Outline(AutomationElement root, string startRef, int max, string[] find, int cap) {
    var o = new LiveOutline();
    bool filter = find != null && find.Length > 0;
    var stack = new Stack<KeyValuePair<AutomationElement, string>>();
    stack.Push(new KeyValuePair<AutomationElement, string>(root, startRef));
    while (stack.Count > 0) {
      var item = stack.Pop(); var el = item.Key; string r = item.Value; o.Visited++;
      if (o.Visited > cap) { o.Truncated = true; break; }
      string role = Role(el), name = Clean(Name(el));
      bool focusable = Flag(el, AutomationElement.IsKeyboardFocusableProperty);
      bool wordy = Wordy.IsMatch(name);
      bool selectable = role == "listitem" && Flag(el, AutomationElement.IsSelectionItemPatternAvailableProperty);
      bool keep = Array.IndexOf(Interactive, role) >= 0 || selectable || (wordy && (role == "text" || role == "image" || role == "header" || role == "headeritem")) || (wordy && focusable && role != "document" && role != "listitem");
      if (keep && filter) keep = Matches(name, find);
      if (keep) {
        if (o.Lines.Count >= max) { o.Truncated = true; break; }
        o.Lines.Add(Line(el, r, role, name)); o.Refs.Add(r); o.Marks.Add(Mark(role, name));
      }
      var kids = Kids(el);
      if (kids != null) for (int k = kids.Count - 1; k >= 0; k--) stack.Push(new KeyValuePair<AutomationElement, string>(kids[k], r + "." + k));
    }
    return o;
  }

  // By accessible name (any case): the first exact match in page order, else the first that contains it.
  public static object[] Find(AutomationElement root, string rootRef, string name, string role, bool skipRoot, int cap) {
    object[] contains = null; int visited = 0;
    var stack = new Stack<KeyValuePair<AutomationElement, string>>();
    stack.Push(new KeyValuePair<AutomationElement, string>(root, rootRef));
    while (stack.Count > 0 && visited < cap) {
      var item = stack.Pop(); var el = item.Key; visited++;
      string n = Name(el);
      if (!(skipRoot && visited == 1) && n.Length > 0 && (string.IsNullOrEmpty(role) || Role(el) == role)) {
        if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return new object[] { el, item.Value };
        if (contains == null && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) contains = new object[] { el, item.Value };
      }
      var kids = Kids(el);
      if (kids != null) for (int k = kids.Count - 1; k >= 0; k--) stack.Push(new KeyValuePair<AutomationElement, string>(kids[k], item.Value + "." + k));
    }
    return contains;
  }

  // The suggestion a creatable box offers for text: an option named exactly the text, else one labelled
  // 'Create "<text>"' or 'Add <text>' (react-select's creatable label).
  public static object[] Suggestion(AutomationElement root, string rootRef, string text, int cap) {
    string want = Clean(text); object[] created = null; int visited = 0;
    var stack = new Stack<KeyValuePair<AutomationElement, string>>();
    stack.Push(new KeyValuePair<AutomationElement, string>(root, rootRef));
    while (stack.Count > 0 && visited < cap) {
      var item = stack.Pop(); var el = item.Key; visited++;
      if (Array.IndexOf(OptionRoles, Role(el)) >= 0) {
        string n = Clean(Name(el));
        if (string.Equals(n, want, StringComparison.OrdinalIgnoreCase)) return new object[] { el, item.Value };
        if (created == null) { var m = CreateLabel.Match(n); if (m.Success && string.Equals(m.Groups[2].Value.Trim(), want, StringComparison.OrdinalIgnoreCase)) created = new object[] { el, item.Value }; }
      }
      var kids = Kids(el);
      if (kids != null) for (int k = kids.Count - 1; k >= 0; k--) stack.Push(new KeyValuePair<AutomationElement, string>(kids[k], item.Value + "." + k));
    }
    return created;
  }

  // How many elements show the text outside the field and its suggestions: a committed entry adds some (a chip and
  // its Remove button, a chosen value). A suggestion's own subtree is skipped, so a list still open counts nothing.
  public static int Shown(AutomationElement root, string text, int cap) {
    string want = Clean(text); int count = 0, visited = 0;
    if (want.Length == 0) return 0;
    var stack = new Stack<AutomationElement>(); stack.Push(root);
    while (stack.Count > 0 && visited < cap) {
      var el = stack.Pop(); visited++;
      string role = Role(el);
      if (Array.IndexOf(OptionRoles, role) >= 0) continue;
      if (role != "edit" && role != "combobox" && Clean(Name(el)).IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) count++;
      var kids = Kids(el);
      if (kids != null) foreach (AutomationElement k in kids) stack.Push(k);
    }
    return count;
  }

  // A ref, resolved one level at a time: one call per level.
  public static AutomationElement ResolveRef(AutomationElement doc, string r) {
    string[] parts = (r ?? "").Split('.');
    if (parts[0] != "0") return null;
    AutomationElement el = doc;
    for (int p = 1; p < parts.Length; p++) {
      int want; if (!int.TryParse(parts[p], out want) || want < 0) return null;
      AutomationElementCollection kids;
      try { kids = el.GetUpdatedCache(KidsReq).CachedChildren; } catch (ElementNotAvailableException) { return null; }
      if (kids == null || want >= kids.Count) return null;
      el = kids[want];
    }
    return el;
  }

  // What each ref showed in the outlines this engine handed out, per window. A ref is a path, so after the page
  // changes it can land on another element; an action through it is then refused instead of hitting the wrong control.
  static readonly Dictionary<long, Dictionary<string, string>> shown = new Dictionary<long, Dictionary<string, string>>();
  public static void Remember(long hwnd, LiveOutline o, bool whole) {
    Dictionary<string, string> map;
    if (whole || !shown.TryGetValue(hwnd, out map)) { map = new Dictionary<string, string>(); shown[hwnd] = map; }
    for (int i = 0; i < o.Refs.Count; i++) map[o.Refs[i]] = o.Marks[i];
  }
  // [what it showed, what it is now] when the ref now resolves to another element; null when it is the same one or
  // was never shown by this engine.
  public static string[] Moved(long hwnd, string r, AutomationElement el) {
    Dictionary<string, string> map; string was;
    if (!shown.TryGetValue(hwnd, out map) || !map.TryGetValue(r, out was)) return null;
    string now;
    try { var c = el.GetUpdatedCache(OneReq); now = Mark(Role(c), Clean(Name(c))); } catch (ElementNotAvailableException) { now = "nothing"; }
    return now == was ? null : new string[] { was, now };
  }

  // The browser's own frame, breadth first, never into a page: its tabs, its address bar and the page in front.
  // One call per frame node fetches that node's children with their facts, so a tab or a page is known without a
  // call of its own.
  public static LiveChrome Chrome(IntPtr hwnd) {
    var c = new LiveChrome();
    var root = AutomationElement.FromHandle(hwnd).GetUpdatedCache(ChromeReq);
    c.Root = root;
    var docs = new List<AutomationElement>();
    var queue = new Queue<KeyValuePair<AutomationElement, int>>();
    queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
    while (queue.Count > 0 && c.Seen < 4000) {
      var item = queue.Dequeue(); var el = item.Key; int depth = item.Value; c.Seen++;
      var ct = Get(el, AutomationElement.ControlTypeProperty) as ControlType;
      if (ct == null) continue;
      if (ct == ControlType.Document) { docs.Add(el); continue; }
      if (ct == ControlType.TabItem) { c.Tabs.Add(el); continue; }
      if (ct == ControlType.Edit && c.Address == null) c.Address = el;
      if (depth >= 30) continue;
      AutomationElementCollection kids;
      // A frame node that closed mid-walk (a tab shutting) has no children left to visit.
      try { kids = object.ReferenceEquals(el, root) ? Kids(root) : Kids(el.GetUpdatedCache(ChromeReq)); } catch (ElementNotAvailableException) { continue; }
      if (kids == null) continue;
      foreach (AutomationElement k in kids) queue.Enqueue(new KeyValuePair<AutomationElement, int>(k, depth + 1));
    }
    double best = -1;
    foreach (var d in docs) {
      if (Flag(d, AutomationElement.IsOffscreenProperty)) continue;
      object b = Get(d, AutomationElement.BoundingRectangleProperty);
      if (!(b is System.Windows.Rect)) continue;
      var rect = (System.Windows.Rect)b;
      double area = rect.IsEmpty ? 0 : rect.Width * rect.Height;
      if (area > best) { best = area; c.Doc = d; }
    }
    return c;
  }
}
'@
# Compiled ONCE PER PC, not once per engine (owner, 2026-10-02: "just make it work faster"). Compiling this C# was
# most of a cold start, 8 to 16 s on a busy PC, and every chat's MCP process paid it on its first browser call. The
# compiled DLL is kept beside this script, named by the hash of the source and the .NET runtime, so a changed source
# or runtime compiles afresh and an unchanged one loads in well under a second. Each engine compiles to its own temp
# name and renames it into place, so two engines starting together never write the same file; a cached DLL that
# will not load is deleted, said on stderr, and compiled again.
if (-not ('LiveTree' -as [type])) {
  $refs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $key = -join ($sha.ComputeHash($utf8.GetBytes($liveSrc + '|' + [System.Environment]::Version.ToString())) | Select-Object -First 8 | ForEach-Object { $_.ToString('x2') })
  $dll = Join-Path $PSScriptRoot ('browser-live-types-' + $key + '.dll')
  $loaded = $false
  if (Test-Path $dll) {
    try { Add-Type -Path $dll; $loaded = $true }
    catch { [Console]::Error.WriteLine('browser_live: cached ' + $dll + ' would not load (' + $_.Exception.Message + '); compiling it again.'); Remove-Item $dll -Force -ErrorAction SilentlyContinue }
  }
  if (-not $loaded) {
    $tmp = $dll + '.' + $PID + '.tmp'
    # -OutputAssembly only writes the file (measured: the types are not loaded until Add-Type -Path), so the temp
    # copy stays unlocked and is removed once the shared name holds a DLL.
    Add-Type -TypeDefinition $liveSrc -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library
    if (-not (Test-Path $dll)) { try { Move-Item $tmp $dll } catch { [Console]::Error.WriteLine('browser_live: another engine cached ' + $dll + ' first (' + $_.Exception.Message + ').') } }
    if (Test-Path $dll) { Add-Type -Path $dll; if (Test-Path $tmp) { Remove-Item $tmp -Force } } else { Add-Type -Path $tmp }
  }
}

$BROWSERS = @{ 'chrome' = 'Chrome'; 'msedge' = 'Edge'; 'brave' = 'Brave'; 'vivaldi' = 'Vivaldi'; 'opera' = 'Opera' }
# Nodes one outline or name search may visit. The cached walk is cheap, so this is a guard against a runaway page,
# not the budget it was when every node cost several cross-process calls.
$VISIT_CAP = 60000
$STEP_ACTIONS = @('click', 'type', 'select', 'key', 'paste', 'wait')
$script:req = $null
$script:answer = $null
$script:pick = @{}
$script:inSteps = $false

# An answer ends the request: it is kept and thrown to the request loop (or to the steps runner, which records it
# as that step's result and goes on or stops). Nothing between here and there may swallow it.
function Out-Json($obj) { $script:answer = $obj; throw 'browser_live_answered' }
function Fail($code, $detail, $hint) { Out-Json ([ordered]@{ ok = $false; error = $code; detail = $detail; hint = $hint }) }

# Literal, case-insensitive 'contains': user text such as '[63%] Node' must never be read as a wildcard pattern.
function Has-Text($hay, $needle) { return ([string]$hay).IndexOf([string]$needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
function Get-RidKey($el) { return [LiveTree]::Rid($el) }
function Tab-Keys($win) { $k = @{}; foreach ($w in (Get-BrowserWindows | Where-Object { $_.pid -eq $win.pid })) { foreach ($t in (Get-Chrome $w).tabs) { $k[(Get-RidKey $t)] = 1 } }; return $k }
function New-Tabs($win, $before) {
  $out = @()
  foreach ($w in (Get-BrowserWindows | Where-Object { $_.pid -eq $win.pid })) {
    $cw = Get-Chrome $w
    foreach ($t in $cw.tabs) { if (-not $before.ContainsKey((Get-RidKey $t))) { $out += ,@{ tab = $t; win = $w; url = $cw.url } } }
  }
  return $out
}
function Get-Pat($el, $pattern) { $p = $null; if ($el.TryGetCurrentPattern($pattern, [ref]$p)) { return $p } ; return $null }
function Name-Of($el) { return [LiveTree]::Name($el) }

function Get-BrowserWindows {
  $out = @()
  foreach ($w in [LiveWin]::Candidates()) {
    $path = [LiveWin]::ImagePath($w.Pid)
    if (-not $path) { continue }
    $exe = [System.IO.Path]::GetFileNameWithoutExtension($path).ToLower()
    if (-not $BROWSERS.ContainsKey($exe)) { continue }
    $cl = [LiveWin]::CommandLine($w.Pid)
    if ($null -eq $cl) { $cl = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$($w.Pid)" -ErrorAction SilentlyContinue).CommandLine }
    $h = [IntPtr]$w.Hwnd
    $title = $w.Title
    $automation = ($title -match 'for Testing$') -or ($path -match 'ms-playwright|chrome-win|Chrome for Testing') -or ($cl -match '--remote-debugging-(port|pipe)')
    $profileDir = ''
    if ([LiveWin]::Prop($h, 2) -match '--profile-directory=("([^"]+)"|(\S+))') { $profileDir = if ($matches[2]) { $matches[2] } else { $matches[3] } }
    $udd = ''
    if ($cl -match '--user-data-dir=("([^"]+)"|(\S+))') { $udd = if ($matches[2]) { $matches[2] } else { $matches[3] } }
    $out += [pscustomobject]@{ hwnd = [int64]$w.Hwnd; pid = $w.Pid; browser = $BROWSERS[$exe]; title = $title; path = $path; front = $w.Front; z = $w.Z; automation = [bool]$automation; app = [bool]($cl -match '--app(-id)?='); userDataDir = $udd; profileDir = $profileDir; profileLabel = [LiveWin]::Prop($h, 4) }
  }
  return $out
}

# The browser's own interface (never web content): tabs, the address bar and the page in front.
function Get-Chrome($win) {
  $c = [LiveTree]::Chrome([IntPtr]$win.hwnd)
  return @{ root = $c.Root; tabs = @($c.Tabs | Where-Object { $null -ne $_ }); address = $c.Address; url = [LiveTree]::Value($c.Address); doc = $c.Doc }
}

function Tab-Info($t, $i) {
  $name = (Name-Of $t) -replace ' - (High )?[Mm]emory usage - [\d.,]+ [KMG]B$', ''
  return [ordered]@{ index = $i; title = $name; active = [LiveTree]::IsSelected($t); id = (Get-RidKey $t) }
}

# A tag's profile (browser + user-data folder + profile folder), as resolved by the Node side.
function Same-Profile($w, $m) { return ($w.browser -eq $m.browser) -and ([string]$w.profileDir -ieq [string]$m.profileDir) -and (([string]$w.userDataDir).TrimEnd('\') -ieq ([string]$m.userDataDir).TrimEnd('\')) }

# The window is picked once per request, so the steps of one call all act in the same window.
function Pick-Window($spec) {
  $key = [string]$spec
  if ($script:pick.ContainsKey($key)) { return $script:pick[$key] }
  $w = Find-Window $spec
  $script:pick[$key] = $w
  return $w
}
function Find-Window($spec) {
  $wins = @(Get-BrowserWindows | Where-Object { -not $_.automation -and -not $_.app })
  if (-not $wins.Count) { Fail 'browser_live_no_window' 'No Chrome, Edge or Brave window is open on this PC.' 'Open your browser first.' }
  if ($req.profileMatch) {
    $m = $req.profileMatch
    $mine = @($wins | Where-Object { Same-Profile $_ $m })
    if (-not $mine.Count) { Fail 'browser_live_tag_not_open' "The browser tagged '$($m.tag)' ($($m.browser) profile folder '$($m.profileDir)') has no open window." "open { window: '$($m.tag)', url } opens one in that profile." }
    $front = $mine | Where-Object { $_.front } | Select-Object -First 1
    if ($front) { return $front }
    return ($mine | Sort-Object z | Select-Object -First 1)
  }
  if ($spec) {
    $n = 0L
    if ([int64]::TryParse([string]$spec, [ref]$n)) { $w = $wins | Where-Object { $_.hwnd -eq $n } | Select-Object -First 1 }
    else { $w = $wins | Where-Object { (Has-Text $_.title $spec) -or $_.browser -eq $spec } | Select-Object -First 1 }
    if (-not $w) { Fail 'browser_live_window_not_found' "No open browser window matches '$spec'." 'Call action:list to see the windows.' }
    return $w
  }
  $front = $wins | Where-Object { $_.front } | Select-Object -First 1
  if ($front) { return $front }
  return ($wins | Sort-Object z | Select-Object -First 1)
}

# Entries older than 12 hours are dropped on read: after a browser restart a recycled window handle could give a
# stale RuntimeId to one of the person's own tabs, and close or restore must never act on that.
function Fresh($entry) { if (-not $entry -or -not $entry.at) { return $false }; try { return ((Get-Date) - [datetime]::Parse([string]$entry.at)).TotalHours -lt 12 } catch { return $false } }
# A file that will not parse is read again (another chat may be mid-write), then refused: treated as empty, a close
# would write over every chat's records and the front-tab rule would lose this chat's tabs.
function Read-State {
  $s = $null
  if ($req.stateFile -and (Test-Path $req.stateFile)) {
    for ($i = 0; $i -lt 3; $i++) {
      try { $s = Get-Content -Raw $req.stateFile | ConvertFrom-Json; break }
      catch {
        if ($i -eq 2) { Fail 'browser_live_state_unreadable' "$($req.stateFile) is not valid JSON ($($_.Exception.Message)), so this chat cannot tell which tabs it opened and nothing was done." 'Fix or delete that file; deleting it forgets which tabs browser_live opened.' }
        Start-Sleep -Milliseconds 100
      }
    }
  }
  if (-not $s) { return [pscustomobject]@{ opened = @(); fronts = @() } }
  return [pscustomobject]@{ opened = @(@($s.opened) | Where-Object { Fresh $_ }); fronts = @(@($s.fronts) | Where-Object { Fresh $_ }) }
}
# Every entry carries the chat that made it (the Node side sends its owner id); a chat acts only on its own.
function Mine($entry) { return [string]$entry.owner -eq [string]$req.owner }
function Save-State($s) { if ($req.stateFile) { $dir = Split-Path $req.stateFile; if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }; ($s | ConvertTo-Json -Depth 5) | Set-Content -Encoding UTF8 $req.stateFile } }

function Find-Tab($tabs, $spec) {
  $i = 0
  foreach ($t in $tabs) { $i++; if ([string]$spec -eq [string]$i -or (Get-RidKey $t) -eq [string]$spec) { return $t } }
  foreach ($t in $tabs) { if ((Has-Text (Name-Of $t) $spec)) { return $t } }
  return $null
}

function Remember-Front($chrome, $win) {
  $s = Read-State
  if (-not @($s.fronts | Where-Object { Mine $_ }).Count) {
    foreach ($t in $chrome.tabs) { if ([LiveTree]::IsSelected($t)) { $s.fronts = @($s.fronts) + @([pscustomobject]@{ owner = [string]$req.owner; hwnd = $win.hwnd; id = (Get-RidKey $t); title = (Name-Of $t); at = (Get-Date).ToString('o') }); break } }
    Save-State $s
  }
}

# Windows accessibility reaches only the tab in FRONT, so an action meant for this chat's tab lands on whatever
# the person switched to (2026-09-30: a read meant for an Apple sign-in tab returned the owner's inbox, twice in one
# chat). read, wait, click, type, select, key and screenshot therefore act only when the front tab is the one
# named in tab, or, with no tab named, one this chat opened in that window; otherwise they refuse and touch nothing.
function Guard-Front($win, $c) {
  if (-not $c) { $c = Get-Chrome $win }
  $act = $null
  foreach ($t in $c.tabs) { if ([LiveTree]::IsSelected($t)) { $act = $t; break } }
  if (-not $act) { return }
  $actId = Get-RidKey $act
  if ($req.tab) {
    $t = Find-Tab $c.tabs $req.tab
    if (-not $t) { Fail 'browser_live_tab_not_found' "No tab matches '$($req.tab)'." 'Call action:list to see the tabs.' }
    if ((Get-RidKey $t) -ne $actId) { Fail 'browser_live_tab_not_front' "Tab '$($req.tab)' is not the one in front, and only the front tab can be reached, so nothing was read or done." 'activate { tab } brings it to the front (the person sees the switch), or wait until they are done.' }
    return
  }
  $s = Read-State
  $mine = @($s.opened | Where-Object { (Mine $_) -and ([string]$_.hwnd -eq [string]$win.hwnd) })
  if ($mine.Count -and -not @($mine | Where-Object { [string]$_.id -eq $actId }).Count) {
    Fail 'browser_live_person_switched' 'The tab in front is not the one this chat opened (the person switched to another tab or closed yours), so nothing was read or done.' 'activate { tab: <your tab id> } once they are done; if they closed it, close {} clears the record; pass tab: naming their tab only when they asked you to use it.'
  }
}
$GUARD_ERRORS = @('browser_live_person_switched', 'browser_live_tab_not_front', 'browser_live_tab_not_found', 'browser_live_no_window', 'browser_live_window_not_found', 'browser_live_tag_not_open')

function Select-Tab($t) {
  $sp = Get-Pat $t ([System.Windows.Automation.SelectionItemPattern]::Pattern)
  if ($sp) { $sp.Select(); return 'select' }
  $ip = Get-Pat $t ([System.Windows.Automation.InvokePattern]::Pattern)
  if ($ip) { $ip.Invoke(); return 'invoke' }
  return $null
}

# The page outline, bounded by max and narrowed by find and from. Refs are child-index paths from the page's
# Document, so they hold until the page changes; each ref's role and name are remembered for the check in Target.
function Page-Outline($win, $c) {
  $page = [ordered]@{ url = $c.url; title = [LiveWin]::Text([IntPtr]$win.hwnd) }
  if (-not $c.doc) { $page.outline = @(); $page.note = 'The page exposes no content yet (still loading, or a browser page such as a new tab).'; return $page }
  $start = $c.doc; $startRef = '0'
  if ($req.from) { $el = [LiveTree]::ResolveRef($c.doc, [string]$req.from); if ($el) { $start = $el; $startRef = [string]$req.from } else { $page.note = "Ref $($req.from) is gone, so this outline is the whole page." } }
  $max = if ($req.max) { [int]$req.max } else { 250 }
  $find = [string[]]@(@($req.find) | Where-Object { $_ })
  $o = [LiveTree]::Outline([LiveTree]::Snapshot($start), $startRef, $max, $find, $VISIT_CAP)
  [LiveTree]::Remember([int64]$win.hwnd, $o, ($startRef -eq '0' -and $find.Count -eq 0))
  $page.outline = @($o.Lines); $page.truncated = $o.Truncated
  return $page
}

# The page as it stands after an action, added to its answer so the next step needs no separate read. A tab the
# person switched to meanwhile is not read (the front-tab rule), and the answer says so; the action stands either way.
function Add-Page($win, $a) {
  try {
    Start-Sleep -Milliseconds 150
    $c = Get-Chrome $win
    Guard-Front $win $c
    $page = Page-Outline $win $c
    foreach ($k in @($page.Keys)) { $a[$k] = $page[$k] }
  } catch {
    if ($null -ne $script:answer) { $a.note = 'No page outline: ' + $script:answer.detail; $script:answer = $null }
    else { $a.note = 'No page outline: ' + $_.Exception.Message }
  }
}

$ROLE_ALIASES = @{ 'link' = 'hyperlink'; 'textbox' = 'edit'; 'input' = 'edit'; 'textarea' = 'edit'; 'select' = 'combobox'; 'radio' = 'radiobutton'; 'option' = 'listitem'; 'tab' = 'tabitem' }
function Norm-Role($role) { if (-not $role) { return '' }; $r = ([string]$role).ToLower(); if ($ROLE_ALIASES.ContainsKey($r)) { $r = $ROLE_ALIASES[$r] }; return $r }

function Target($chrome, $win) {
  if (-not $chrome.doc) { Fail 'browser_live_no_page' 'The active tab exposes no page content to Windows accessibility yet.' 'Wait a moment and read again; a page still loading has no document.' }
  if ($req.ref) {
    $el = [LiveTree]::ResolveRef($chrome.doc, [string]$req.ref)
    if (-not $el) { Fail 'browser_live_ref_gone' "Ref $($req.ref) no longer exists - the page changed since it was read." 'Read the page again (action:read) and use the new ref, or target by name.' }
    $moved = [LiveTree]::Moved([int64]$win.hwnd, [string]$req.ref, $el)
    if ($moved) { Fail 'browser_live_ref_gone' "Ref $($req.ref) now points at $($moved[1]), not the $($moved[0]) it showed - the page changed since it was read, so nothing was done." 'Use the ref from the newest outline (each click, type, select and steps answer carries one), or target by name + role.' }
    return @($el, [string]$req.ref)
  }
  if ($req.name) {
    $role = Norm-Role $req.role
    # Inside steps a field may still be rendering after the step before it, so a name gets a second look.
    for ($try = 0; $true; $try++) {
      $hit = [LiveTree]::Find([LiveTree]::Names($chrome.doc), '0', [string]$req.name, $role, $false, $VISIT_CAP)
      if ($hit -or -not $script:inSteps -or $try -ge 4) { break }
      Start-Sleep -Milliseconds 250
      $chrome = Get-Chrome $win; Guard-Front $win $chrome
      if (-not $chrome.doc) { break }
    }
    if (-not $hit) { Fail 'browser_live_not_found' "Nothing named '$($req.name)'$(if ($req.role) { ' with role ' + $req.role }) is on the page." 'Read the page (action:read, find:"...") to see what is there.' }
    return $hit
  }
  Fail 'browser_live_target_required' 'Name the element: ref (from action:read) or name (+ role).' ''
}

function Click-Point($el) {
  $pt = New-Object System.Windows.Point
  if (-not $el.TryGetClickablePoint([ref]$pt)) { $r = $el.Current.BoundingRectangle; $pt = New-Object System.Windows.Point (($r.Left + $r.Width / 2), ($r.Top + $r.Height / 2)) }
  return $pt
}

# A real mouse click goes to screen coordinates, so an element scrolled out of the page would be clicked wherever
# those coordinates fall (another checkbox, another window; Cloudflare form, 2026-10-07). Scroll it into view when it
# (or an ancestor) can, then refuse unless the point sits inside the page and the window.
function Assert-OnPage($el, $win, $x, $y) {
  $chrome = Get-Chrome $win
  $wr = New-Object LiveWin+RECT
  [void][LiveWin]::GetWindowRect([IntPtr]$win.hwnd, [ref]$wr)
  $d = if ($chrome.doc) { $chrome.doc.Current.BoundingRectangle } else { $null }
  $inDoc = $d -and -not $d.IsEmpty -and $x -ge $d.Left -and $x -le $d.Right -and $y -ge $d.Top -and $y -le $d.Bottom
  $inWin = $x -ge $wr.Left -and $x -le $wr.Right -and $y -ge $wr.Top -and $y -le $wr.Bottom
  if (-not ($inDoc -and $inWin)) { Fail 'browser_live_offscreen' "The click point $([int]$x),$([int]$y) is outside the visible page, so a mouse click there would land on something else." 'Scroll the element into view (read it, or type into a field near it) and retry.' }
}
# Keys sent to the page must land in it: true when el is root or one of its descendants (the walk is up the raw tree).
function In-Subtree($el, $root) {
  if (-not $el -or -not $root) { return $false }
  $walk = [System.Windows.Automation.TreeWalker]::RawViewWalker
  for ($n = $el; $n -and $n -ne [System.Windows.Automation.AutomationElement]::RootElement; $n = $walk.GetParent($n)) {
    if ([System.Windows.Automation.Automation]::Compare($n, $root)) { return $true }
  }
  return $false
}
# A real click puts keyboard focus in a rich-text editor (it exposes no value to set), and the focus is then checked
# before any key is sent: keys that miss the field would otherwise be typed into the browser itself.
function Mouse-Focus($el, $win) {
  Scroll-Into-View $el
  $r = $el.Current.BoundingRectangle
  $x = $r.Left + $r.Width / 2; $y = $r.Top + $r.Height / 2
  Assert-OnPage $el $win $x $y
  if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'Windows would not bring the browser to the front, so the click and keys would land in another window.' 'Click the browser window once, then retry.' }
  [LiveWin]::Click([int]$x, [int]$y)
  Start-Sleep -Milliseconds 150
  $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not (In-Subtree $fe $el)) { Fail 'browser_live_focus_missed' "The click did not give that field keyboard focus (focus is on '$(if ($fe) { $fe.Current.Name } else { 'nothing' })'), so nothing was typed." 'Click the field once yourself, then retry; or type into a field that takes a value (type without keyboard:true).' }
}
function Scroll-Into-View($el) {
  $walk = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($n = $el; $n -and $n -ne [System.Windows.Automation.AutomationElement]::RootElement; $n = $walk.GetParent($n)) {
    $sp = Get-Pat $n ([System.Windows.Automation.ScrollItemPattern]::Pattern)
    if ($sp) { try { $sp.ScrollIntoView(); Start-Sleep -Milliseconds 150 } catch { }; return }
  }
}

function Act-Click($el, $win) {
  $how = $null
  if ($null -ne $req.offsetX -or $null -ne $req.offsetY) {
    Scroll-Into-View $el
    $r = $el.Current.BoundingRectangle
    $x = if ($null -ne $req.offsetX) { $r.Left + [double]$req.offsetX } else { $r.Left + $r.Width / 2 }
    $y = if ($null -ne $req.offsetY) { $r.Top + [double]$req.offsetY } else { $r.Top + $r.Height / 2 }
    Assert-OnPage $el $win $x $y
    if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'Windows would not bring the browser to the front, so a mouse click would land on another window.' 'Click the browser window once, then retry.' }
    [LiveWin]::Click([int]$x, [int]$y)
    return "mouse at $([int]$x),$([int]$y) (element $([int]$r.Left),$([int]$r.Top) $([int]$r.Width)x$([int]$r.Height))"
  }
  $ip = Get-Pat $el ([System.Windows.Automation.InvokePattern]::Pattern); if ($ip) { $ip.Invoke(); $how = 'invoke' }
  if (-not $how) { $tp = Get-Pat $el ([System.Windows.Automation.TogglePattern]::Pattern); if ($tp) { $tp.Toggle(); $how = 'toggle' } }
  if (-not $how) { $sp = Get-Pat $el ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($sp) { $sp.Select(); $how = 'select' } }
  if (-not $how) { $ep = Get-Pat $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($ep) { if ($ep.Current.ExpandCollapseState -eq 'Collapsed') { $ep.Expand() } else { $ep.Collapse() }; $how = 'expand' } }
  if (-not $how -and $req.mouse) {
    Scroll-Into-View $el
    $pt = Click-Point $el
    $r = $el.Current.BoundingRectangle
    Assert-OnPage $el $win $pt.X $pt.Y
    if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'Windows would not bring the browser to the front, so a mouse click would land on another window.' 'Click the browser window once, then retry.' }
    [LiveWin]::Click([int]$pt.X, [int]$pt.Y)
    $how = "mouse at $([int]$pt.X),$([int]$pt.Y) (element $([int]$r.Left),$([int]$r.Top) $([int]$r.Width)x$([int]$r.Height))"
  }
  if (-not $how) { Fail 'browser_live_not_clickable' 'That element offers no accessible click (invoke, toggle, select or expand).' 'Retry with mouse:true to click it with the real mouse (the browser comes to the front for a moment).' }
  return $how
}

# A creatable chip box (react-select style; Cloudflare's token IP filter, 2026-10-02) keeps typed text only once a
# suggestion is picked: the Value pattern alone left 'Enter valid IP addresses'. A box that clears its text on blur
# makes "the field let go of the text" no proof, so committed means EVIDENCE: more of the page, outside the field and
# its suggestions, shows the text than before (a chip, its Remove button, a chosen value).
function Find-Suggestion($win, $want) {
  for ($i = 0; $i -lt 10; $i++) {
    if ($i) { Start-Sleep -Milliseconds 75 }
    $c = Get-Chrome $win
    if (-not $c.doc) { continue }
    $names = [LiveTree]::Names($c.doc)
    $opt = [LiveTree]::Suggestion($names, '0', $want, $VISIT_CAP)
    if ($opt) { return @{ opt = $opt[0]; shown = [LiveTree]::Shown($names, $want, $VISIT_CAP) } }
  }
  return $null
}
function Entry-Committed($win, $want, $shown) {
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 75
    $c = Get-Chrome $win
    if (-not $c.doc) { continue }
    $names = [LiveTree]::Names($c.doc)
    if ([LiveTree]::Shown($names, $want, $VISIT_CAP) -gt $shown) { return $true }
  }
  return $false
}
# Picks the suggestion named exactly the text (or 'Create "<text>"') through accessibility first, so the person keeps
# the mouse; when the page ignored that (it picks only the option a real pointer hovered), types the text again if the
# box dropped it and clicks the suggestion with the real mouse. With no suggestion it presses Enter in the field.
# Without the front window it refuses (browser_live_not_foreground), never a silent no-op.
function Commit-Entry($el, $want, $win) {
  $found = Find-Suggestion $win $want
  if ($found) {
    $o = $found.opt; $label = [LiveTree]::Clean((Name-Of $o))
    $how = $null
    $ip = Get-Pat $o ([System.Windows.Automation.InvokePattern]::Pattern); if ($ip) { $ip.Invoke(); $how = 'invoke' }
    if (-not $how) { $sp = Get-Pat $o ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($sp) { $sp.Select(); $how = 'select' } }
    if ($how -and (Entry-Committed $win $want $found.shown)) { return "picked '$label' ($how)" }
    if ($how -and ((([LiveTree]::Value($el)) -replace "\r\n", "\n") -ne $want)) {
      $vp = Get-Pat $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $vp.SetValue([string]$req.text) }
      $found = Find-Suggestion $win $want
      if (-not $found) { Fail 'browser_live_commit_failed' "The accessible pick of '$label' changed nothing, and typing the text again brought no suggestion back." 'Read the page to see what the box shows.' }
      $o = $found.opt
    }
    $pt = Click-Point $o
    if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' "The text was typed, but Windows would not bring the browser to the front, so the suggestion '$label' could not be clicked and the entry is not committed." 'Click the browser window once, then retry.' }
    [LiveWin]::Click([int]$pt.X, [int]$pt.Y)
    if (Entry-Committed $win $want $found.shown) { return "picked '$label' (mouse)" }
    Fail 'browser_live_commit_failed' "The text was typed and the suggestion '$label' was clicked, but the page shows no new entry for it." 'Read the page to see what the box shows.'
  }
  $c = Get-Chrome $win
  $shown = if ($c.doc) { [LiveTree]::Shown([LiveTree]::Names($c.doc), $want, $VISIT_CAP) } else { 0 }
  if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'The text was typed, but Windows would not bring the browser to the front, so Enter could not reach the field and the entry is not committed.' 'Click the browser window once, then retry.' }
  $el.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  if (Entry-Committed $win $want $shown) { return 'enter' }
  Fail 'browser_live_commit_failed' 'The text was typed and Enter pressed in the field, but it offered no suggestion and the page shows no new entry for it.' 'Read the page: the box may reject the text, or want a suggestion picked by hand.'
}

# One request, answered through Out-Json or Fail.
function Invoke-Request {
  $action = [string]$req.action
  switch ($action) {
    'list' {
      $wins = @(Get-BrowserWindows)
      $rows = @()
      foreach ($w in ($wins | Sort-Object z)) {
        $row = [ordered]@{ window = $w.hwnd; browser = $w.browser; title = $w.title; front = $w.front; profileDir = $w.profileDir }
        if ($w.userDataDir) { $row.userDataDir = $w.userDataDir }
        if ($w.automation) { $row.automation = $true }
        if ($w.app) { $row.app = $true }
        if (-not $w.automation -and -not $w.app) {
          $c = Get-Chrome $w; $i = 0
          $row.tabs = @($c.tabs | ForEach-Object { $i++; Tab-Info $_ $i })
          $row.url = $c.url
        }
        $rows += [pscustomobject]$row
      }
      Out-Json ([ordered]@{ ok = $true; windows = $rows })
    }
    'read' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      if ($c.doc -and $req.from -and -not [LiveTree]::ResolveRef($c.doc, [string]$req.from)) { Fail 'browser_live_ref_gone' "Ref $($req.from) no longer exists - the page changed since it was read." 'Read the whole page again.' }
      $page = Page-Outline $win $c
      $res = [ordered]@{ ok = $true; window = $win.hwnd }
      foreach ($k in @($page.Keys)) { $res[$k] = $page[$k] }
      Out-Json $res
    }
    'activate' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win
      if (-not $req.tab) { Fail 'browser_live_tab_required' 'Name the tab: its number from action:list, its id, or part of its title.' '' }
      $t = Find-Tab $c.tabs $req.tab
      if (-not $t) { Fail 'browser_live_tab_not_found' "No tab matches '$($req.tab)'." 'Call action:list to see the tabs.' }
      Remember-Front $c $win
      $how = Select-Tab $t
      Out-Json ([ordered]@{ ok = [bool]$how; window = $win.hwnd; tab = (Tab-Info $t 0); how = $how })
    }
    'identify' {
      $win = Pick-Window $req.window
      Out-Json ([ordered]@{ ok = $true; hwnd = $win.hwnd; browser = $win.browser; title = $win.title; profileDir = $win.profileDir; profileLabel = $win.profileLabel; userDataDir = $win.userDataDir })
    }
    'value' {
      # Internal to secret_clipboard (not in BROWSER_LIVE_ACTIONS, so browser_live itself can never ask for it):
      # the element's value goes back to the calling MCP process, which seals it and never returns it.
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      $hit = Target $c $win; $el = $hit[0]
      if ($el.Current.IsPassword) { Fail 'browser_live_password_field' 'That is a password field. Passwords stay with the person, never an agent.' '' }
      $val = ''
      $vp = Get-Pat $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $val = [string]$vp.Current.Value }
      if (-not $val) { $val = [string]$el.Current.Name }
      Out-Json ([ordered]@{ ok = $true; value = $val; url = $c.url })
    }
    'open' {
      # A tagged profile opens in its own folder (with no window of its own open, the browser starts one),
      # unless the call names another folder: then the tag only picks the window to act from.
      $m = $req.profileMatch; $profileDir = [string]$req.profileDirectory
      if ($m -and -not $profileDir) {
        $profileDir = [string]$m.profileDir
        $mine = @(Get-BrowserWindows | Where-Object { -not $_.automation -and -not $_.app -and (Same-Profile $_ $m) })
        if ($mine.Count) { $win = Pick-Window $null }
        else {
          $win = @(Get-BrowserWindows | Where-Object { -not $_.automation -and -not $_.app -and $_.browser -eq $m.browser -and (([string]$_.userDataDir).TrimEnd('\') -ieq ([string]$m.userDataDir).TrimEnd('\')) }) | Select-Object -First 1
          if (-not $win) { Fail 'browser_live_no_window' "No $($m.browser) window is open to start the tagged profile from." 'Open the browser first.' }
        }
      } else { $win = Pick-Window $req.window }
      $c = Get-Chrome $win
      Remember-Front $c $win
      $before = Tab-Keys $win
      $argv = @()
      if ($m -and $m.userDataDir) { $argv += ('--user-data-dir="' + [string]$m.userDataDir + '"') }
      if ($profileDir) { $argv += ('--profile-directory="' + $profileDir + '"') }
      $argv += [string]$req.url
      Start-Process -FilePath $win.path -ArgumentList $argv | Out-Null
      # Which new tab is OURS: the person may open a tab at the same moment (2026-09-29, a D&B tab went
      # unrecorded while the owner opened the AWS console), and close must never shut theirs. A tab counts as ours
      # when it is the active tab of its window and that window's address is on the site we asked for (the
      # last two labels, so a redirect to my.dnb.com or accounts.google.com still matches); a lone new tab
      # counts too. Several new tabs and no match: record none and say so.
      # The Node side refused any url that does not parse as http(s), so this cannot throw on a real request.
      $site = (([Uri][string]$req.url).Host.ToLower().Split('.') | Select-Object -Last 2) -join '.'
      $new = $null; $newWin = $null; $fresh = @()
      for ($i = 0; $i -lt 40 -and -not $new; $i++) {
        Start-Sleep -Milliseconds 250
        $fresh = @()
        foreach ($w in (Get-BrowserWindows | Where-Object { $_.pid -eq $win.pid })) {
          $cw = Get-Chrome $w
          foreach ($t in $cw.tabs) {
            if ($before.ContainsKey((Get-RidKey $t))) { continue }
            $fresh += ,@($t, $w)
            if ($site -and [LiveTree]::IsSelected($t) -and (Has-Text $cw.url $site)) { $new = $t; $newWin = $w }
          }
        }
      }
      if (-not $new -and $fresh.Count -eq 1) { $new = $fresh[0][0]; $newWin = $fresh[0][1] }
      if (-not $new -and $fresh.Count -gt 1) { Fail 'browser_live_open_ambiguous' "$($fresh.Count) new tabs appeared while opening (the person opened one at the same moment) and none showed $site, so none was recorded and close will not touch them." 'Call action:list, then close yours with close { tab: <its id>, force: true }.' }
      if (-not $new) { Fail 'browser_live_open_unconfirmed' 'The browser was asked to open the page but no new tab appeared within 10 seconds.' 'Call action:list to look for it.' }
      $s = Read-State
      $s.opened = @($s.opened) + @([pscustomobject]@{ owner = [string]$req.owner; hwnd = $newWin.hwnd; id = (Get-RidKey $new); url = [string]$req.url; at = (Get-Date).ToString('o') })
      Save-State $s
      Out-Json ([ordered]@{ ok = $true; window = $newWin.hwnd; tab = (Tab-Info $new 0) })
    }
    'wait' {
      $win = Pick-Window $req.window
      $deadline = (Get-Date).AddMilliseconds($(if ($req.timeoutMs) { [int]$req.timeoutMs } else { 15000 }))
      do {
        $c = Get-Chrome $win; Guard-Front $win $c
        if ($c.doc) {
          if (-not $req.text) { Out-Json ([ordered]@{ ok = $true; url = $c.url; title = [LiveWin]::Text([IntPtr]$win.hwnd) }) }
          $hit = [LiveTree]::Find([LiveTree]::Names($c.doc), '0', [string]$req.text, '', $false, $VISIT_CAP)
          if ($hit) { Out-Json ([ordered]@{ ok = $true; url = $c.url; found = [LiveTree]::LineOf($hit[0], $hit[1]) }) }
        }
        Start-Sleep -Milliseconds 300
      } while ((Get-Date) -lt $deadline)
      Fail 'browser_live_wait_timeout' "The page did not show '$($req.text)' in time." 'Read the page to see where it is.'
    }
    'click' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      $hit = Target $c $win
      $before = Tab-Keys $win
      $how = Act-Click $hit[0] $win
      # A link with target=_blank opens its tab a moment after the click. The tab is the chat's own only when it is
      # the sole new tab and it is showing: a tab the person opens at the same moment must never be recorded.
      $fresh = @()
      for ($i = 0; $i -lt 6 -and -not $fresh.Count; $i++) { Start-Sleep -Milliseconds 250; $fresh = @(New-Tabs $win $before) }
      $result = [ordered]@{ ok = $true; how = $how; clicked = [LiveTree]::LineOf($hit[0], $hit[1]) }
      if ($fresh.Count -eq 1 -and [LiveTree]::IsSelected($fresh[0].tab)) {
        $s = Read-State
        $s.opened = @($s.opened) + @([pscustomobject]@{ owner = [string]$req.owner; hwnd = $fresh[0].win.hwnd; id = (Get-RidKey $fresh[0].tab); url = [string]$fresh[0].url; at = (Get-Date).ToString('o') })
        Save-State $s
        $result.openedTab = (Tab-Info $fresh[0].tab 0)
      }
      Out-Json $result
    }
    'type' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      $hit = Target $c $win; $el = $hit[0]
      if ($el.Current.IsPassword) { Fail 'browser_live_password_field' 'That is a password field. Passwords are typed by the person, never by an agent.' 'Ask the person to type it.' }
      $vp = Get-Pat $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp -and -not $vp.Current.IsReadOnly) {
        $want = ([string]$req.text) -replace "\r\n", "\n"
        $vp.SetValue([string]$req.text)
        # Read it back: a page's maxlength silently keeps only the first N characters (Stripe's support
        # email box keeps 10,000), and a cut message must never be reported as typed. A script-driven field
        # can read empty for a moment while the page redraws it, or be swapped for a fresh element (D&B's
        # search box read 0 of 22 and then showed all 22, 2026-09-29), so poll, and re-find it once, before
        # calling it cut. Polled every 50 ms (Chrome reports a new value a frame or two late), for the same 1.6 s
        # with the re-find at the same 0.8 s as the 200 ms polls before.
        $got = ''
        for ($i = 0; $i -lt 32; $i++) {
          if ($i -eq 16) {
            $doc2 = (Get-Chrome $win).doc; $el2 = $null
            if ($doc2 -and $req.ref) { $el2 = [LiveTree]::ResolveRef($doc2, [string]$req.ref) } elseif ($doc2) { $h2 = [LiveTree]::Find([LiveTree]::Names($doc2), '0', [string]$req.name, (Norm-Role $req.role), $false, $VISIT_CAP); if ($h2) { $el2 = $h2[0] } }
            if ($el2) { $again = Get-Pat $el2 ([System.Windows.Automation.ValuePattern]::Pattern); if ($again) { $vp = $again } }
          }
          $got = ([string]$vp.Current.Value) -replace "\r\n", "\n"
          if ($got -eq $want) { break }
          Start-Sleep -Milliseconds 50
        }
        $res = [ordered]@{ ok = $true; how = 'value'; typed = [LiveTree]::LineOf($el, $hit[1]); requested = $want.Length; landed = $got.Length }
        if ($got -ne $want) { $res.ok = $false; $res.error = 'browser_live_value_mismatch'; $res.detail = "The field kept $($got.Length) of $($want.Length) characters - the page cut or changed the text (a length limit, a mask or an auto-format)."; $res.hint = 'Shorten the text to fit, or split it, and type again.' }
        elseif ($req.commit) { $res.commit = Commit-Entry $el $want $win; $res.typed = [LiveTree]::LineOf($el, $hit[1]) }
        Out-Json $res
      }
      if (-not $req.keyboard) { Fail 'browser_live_not_typable' 'That element takes no accessible text value.' 'Retry with keyboard:true to focus it and type with the real keyboard (the browser comes to the front for a moment).' }
      if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'Windows would not bring the browser to the front, so the keystrokes would land in another window.' 'Click the browser window once, then retry.' }
      Mouse-Focus $el $win
      $esc = ([string]$req.text) -replace '([+^%~(){}\[\]])', '{$1}'
      [System.Windows.Forms.SendKeys]::SendWait($esc)
      Out-Json ([ordered]@{ ok = $true; how = 'keys'; typed = [LiveTree]::LineOf($el, $hit[1]) })
    }
    'select' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      $hit = Target $c $win; $el = $hit[0]
      $ep = Get-Pat $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      # A list that will not open or close through accessibility is said in the answer, never passed over.
      $listNotes = @()
      if ($ep) { try { $ep.Expand() } catch { $listNotes += "the list would not open through accessibility ($($_.Exception.Message))" } }
      # The open list's options, looked for every 60 ms for up to the 300 ms the list used to be given to draw.
      $found = $null
      for ($i = 0; $i -lt 6 -and -not $found; $i++) {
        if ($i) { Start-Sleep -Milliseconds 60 }
        $found = [LiveTree]::Find([LiveTree]::Names($el), [string]$hit[1], [string]$req.option, '', $true, $VISIT_CAP)
      }
      if (-not $found) {
        # The list this call opened is closed again, so the page is left as it was found.
        if ($ep) { try { if ($ep.Current.ExpandCollapseState -eq 'Expanded') { $ep.Collapse() } } catch { $listNotes += "it did not close again ($($_.Exception.Message))" } }
        Fail 'browser_live_option_not_found' "No option '$($req.option)' in that list$(if ($listNotes.Count) { '; ' + ($listNotes -join '; ') })." 'Read the page after clicking the list open to see its options.'
      }
      $opt = $found[0]
      $how = Act-Click $opt $win
      if ($ep) { try { if ($ep.Current.ExpandCollapseState -eq 'Expanded') { $ep.Collapse() } } catch { $listNotes += "the list did not close afterwards ($($_.Exception.Message))" } }
      $res = [ordered]@{ ok = $true; how = $how; selected = (Name-Of $opt) }
      if ($listNotes.Count) { $res.listNote = $listNotes -join '; ' }
      Out-Json $res
    }
    'key' {
      $win = Pick-Window $req.window; Guard-Front $win $null
      if (-not [LiveWin]::Front([IntPtr]$win.hwnd)) { Fail 'browser_live_not_foreground' 'Windows would not bring the browser to the front, so the keys would land in another window.' 'Click the browser window once, then retry.' }
      # Focus in the tab strip or omnibox sends the keys to the browser itself (a ^w there closed the wrong tab), so keys go only where focus is in the page.
      if (-not $req.force) {
        $kc = Get-Chrome $win
        if (-not (In-Subtree ([System.Windows.Automation.AutomationElement]::FocusedElement) $kc.doc)) { Fail 'browser_live_focus_in_browser' 'Keyboard focus is in the browser itself (tab strip, address bar or a dialog), not the page, so these keys would not reach the page.' 'Click into the page once, or pass force:true if the person asked for keys in the browser.' }
      }
      [System.Windows.Forms.SendKeys]::SendWait([string]$req.keys)
      Out-Json ([ordered]@{ ok = $true; sent = [string]$req.keys })
    }
    'paste' {
      $win = Pick-Window $req.window; $c = Get-Chrome $win; Guard-Front $win $c
      $hit = Target $c $win; $el = $hit[0]
      Mouse-Focus $el $win
      # The clipboard is put back as it was (text only: Set-Clipboard cannot hold other formats), so the person's own copy is never replaced by the agent's text.
      $saved = Get-Clipboard -Raw
      Set-Clipboard -Value ([string]$req.text)
      [System.Windows.Forms.SendKeys]::SendWait('^a{DEL}^v')
      Start-Sleep -Milliseconds 200
      Set-Clipboard -Value ([string]$saved)
      Out-Json ([ordered]@{ ok = $true; how = 'paste'; pasted = [LiveTree]::LineOf($el, $hit[1]) })
    }
    'screenshot' {
      $win = Pick-Window $req.window; Guard-Front $win $null
      $r =New-Object LiveWin+RECT
      [void][LiveWin]::GetWindowRect([IntPtr]$win.hwnd, [ref]$r)
      $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
      if ($w -le 0 -or $h -le 0) { Fail 'browser_live_minimized' 'The window is minimized, so there is nothing to capture.' '' }
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc()
      [void][LiveWin]::PrintWindow([IntPtr]$win.hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc); $g.Dispose()
      $maxW = if ($req.maxWidth) { [int]$req.maxWidth } else { 1800 }
      if ($w -gt $maxW) {
        # High-quality resampling: the Bitmap(image, w, h) shortcut resizes with GDI+'s default filter, which turns small text to mush.
        $nh = [int]($h * $maxW / $w); $small = New-Object System.Drawing.Bitmap $maxW, $nh
        $sg = [System.Drawing.Graphics]::FromImage($small)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $sg.DrawImage($bmp, 0, 0, $maxW, $nh); $sg.Dispose(); $bmp.Dispose(); $bmp = $small
      }
      $shownW = $bmp.Width; $shownH = $bmp.Height
      if ([string]$req.format -eq 'png') { $bmp.Save([string]$req.path, [System.Drawing.Imaging.ImageFormat]::Png) }
      else {
        $q = if ($req.quality) { [int64]$req.quality } else { [int64]80 }
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $ep2 = New-Object System.Drawing.Imaging.EncoderParameters 1
        $ep2.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), $q
        $bmp.Save([string]$req.path, $codec, $ep2)
      }
      $bmp.Dispose()
      Out-Json ([ordered]@{ ok = $true; path = [string]$req.path; window = $win.hwnd; shownWidth = $shownW; shownHeight = $shownH; windowWidth = $w; windowHeight = $h })
    }
    'close' {
      $s = Read-State
      $closed = @(); $missing = 0; $closedShowing = $false
      $wins = @(Get-BrowserWindows | Where-Object { -not $_.automation })
      $targets = @($s.opened | Where-Object { Mine $_ })
      if ($req.tab) {
        $targets = @($targets | Where-Object { $_.id -eq [string]$req.tab -or (Has-Text $_.url $req.tab) })
        if (-not $targets.Count -and -not $req.force) { Fail 'browser_live_not_yours' "The tab '$($req.tab)' was not opened by browser_live in this chat, so it is the person's (or another chat's) and stays open." 'Pass force:true only when the person asked for that tab to close.' }
        if (-not $targets.Count) { foreach ($w in $wins) { $t = Find-Tab (Get-Chrome $w).tabs $req.tab; if ($t) { $targets = @([pscustomobject]@{ hwnd = $w.hwnd; id = (Get-RidKey $t); url = '' }); break } } }
      }
      foreach ($o in $targets) {
        $found = $null
        foreach ($w in $wins) { foreach ($t in (Get-Chrome $w).tabs) { if ((Get-RidKey $t) -eq $o.id) { $found = $t; break } }; if ($found) { break } }
        if (-not $found) { $missing++; continue }
        $wasShowing = [LiveTree]::IsSelected($found)
        $btn = $found.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
        $ip = if ($btn) { Get-Pat $btn ([System.Windows.Automation.InvokePattern]::Pattern) } else { $null }
        if ($ip) { $ip.Invoke(); $closed += $o.id; if ($wasShowing) { $closedShowing = $true } }
      }
      # Put the person's front tab back only when a tab we closed was the one showing: if they have moved on to
      # another tab since, switching them away from it would be yanking their view, not restoring it.
      $restored = $null
      $front = @($s.fronts | Where-Object { Mine $_ }) | Select-Object -First 1
      if (-not $req.tab -and $front -and $closedShowing) {
        Start-Sleep -Milliseconds 300
        foreach ($w in $wins) { foreach ($t in (Get-Chrome $w).tabs) { if ((Get-RidKey $t) -eq $front.id) { [void](Select-Tab $t); $restored = (Name-Of $t) -replace ' - (High )?[Mm]emory usage - [\d.,]+ [KMG]B$', ''; break } }; if ($restored) { break } }
      }
      # Re-read before saving: closing took seconds, and another chat may have recorded a tab meanwhile.
      $s = Read-State
      $left = @($s.opened | Where-Object { $closed -notcontains $_.id })
      if (-not $req.tab) { $left = @($s.opened | Where-Object { -not (Mine $_) }); $s.fronts = @($s.fronts | Where-Object { -not (Mine $_) }) }
      $s.opened = $left
      Save-State $s
      Out-Json ([ordered]@{ ok = $true; closed = $closed.Count; alreadyGone = $missing; restoredFrontTab = $restored })
    }
    'steps' { Run-Steps }
    default { Fail 'browser_live_unknown_action' "Unknown action '$action'." 'Use list, read, activate, open, wait, click, type, select, key, steps, screenshot or close.' }
  }
}

# One request's answer, whether it came through Out-Json, Fail or an exception.
function Run-One {
  try { Invoke-Request } catch { if ($null -eq $script:answer) { $script:answer = [ordered]@{ ok = $false; error = 'browser_live_engine_failed'; detail = ('' + $_.Exception.Message) } } }
  if ($null -eq $script:answer) { $script:answer = [ordered]@{ ok = $false; error = 'browser_live_engine_failed'; detail = 'The engine gave no answer.' } }
  $a = $script:answer; $script:answer = $null
  return $a
}

# steps: each step runs as its own request in the call's window and tab, in order, until one fails; then one outline
# of the page. A failure the front-tab rule raised reads nothing, so it gets no outline.
function Run-Steps {
  $parent = $script:req
  $win = Pick-Window $parent.window
  $results = New-Object System.Collections.ArrayList
  $failed = $null; $failedAction = ''
  $script:inSteps = $true
  try {
    $i = 0
    foreach ($s in @($parent.steps)) {
      $i++
      $h = [ordered]@{}
      foreach ($p in $s.PSObject.Properties) { $h[$p.Name] = $p.Value }
      foreach ($k in @('window', 'tab', 'owner', 'stateFile', 'profileMatch')) { $h.Remove($k); if ($null -ne $parent.$k) { $h[$k] = $parent.$k } }
      if ($STEP_ACTIONS -notcontains [string]$s.action) { $a = [ordered]@{ ok = $false; error = 'browser_live_step_refused'; detail = "'$($s.action)' cannot run inside steps." } }
      else { $script:req = [pscustomobject]$h; $a = Run-One; $script:req = $parent }
      $row = [ordered]@{ step = $i; action = [string]$s.action }
      foreach ($k in @($a.Keys)) { $row[$k] = $a[$k] }
      [void]$results.Add($row)
      if (-not $a.ok) { $failed = $a; $failedAction = [string]$s.action; break }
      if ([string]$s.action -ne 'wait') { Start-Sleep -Milliseconds 50 }
    }
  } finally { $script:inSteps = $false; $script:req = $parent }
  $res = [ordered]@{ ok = ($null -eq $failed); ran = $results.Count; of = @($parent.steps).Count; window = $win.hwnd }
  if ($failed) { $res.error = $failed.error; $res.detail = "Step $($results.Count) ($failedAction) failed: $($failed.detail)"; if ($failed.hint) { $res.hint = $failed.hint } }
  $res.steps = @($results)
  if (-not $failed -or $GUARD_ERRORS -notcontains [string]$failed.error) { Add-Page $win $res }
  Out-Json $res
}

# click, type and select answer with the page after them; steps adds its own page once, at the end.
function Run-Top {
  $script:pick = @{}
  $script:inSteps = $false
  $action = [string]$req.action
  if (@('click', 'type', 'select') -contains $action) {
    $a = Run-One
    if ($a.ok) { Add-Page (Pick-Window $req.window) $a }
    Out-Json $a
  }
  Invoke-Request
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $script:answer = $null
  $id = $null
  try { $script:req = $line | ConvertFrom-Json; $id = $script:req.id; Run-Top }
  catch { if ($null -eq $script:answer) { $script:answer = [ordered]@{ ok = $false; error = 'browser_live_engine_failed'; detail = ('' + $_.Exception.Message) } } }
  $a = $script:answer
  if ($null -eq $a) { $a = [ordered]@{ ok = $false; error = 'browser_live_engine_failed'; detail = 'The engine gave no answer.' } }
  $a['id'] = $id
  [Console]::Out.WriteLine(($a | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
