param(
  [Parameter(Mandatory=$true)][int]$OwnerPid,
  [Parameter(Mandatory=$true)][string]$Profile,
  [ValidateSet('Inspect','Capture','Invoke','Expand','Collapse','SetValue','PostClick','PostText')][string]$Action = 'Inspect',
  [string]$RuntimeId = '',
  [string]$ExpectedName = '',
  [string]$Value = '',
  [string]$Screenshot = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class BackgroundClaudePoc {
  public delegate bool EnumCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, EnumCallback callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid interfaceId, [In,Out,MarshalAs(UnmanagedType.IUnknown)] ref object accessible);
  [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr context, uint flags);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RectangleNative rectangle);
  [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref PointNative point);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr position);
  [StructLayout(LayoutKind.Sequential)] private struct PointNative { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] private struct RectangleNative { public int left, top, right, bottom; }
  public static void Wake(IntPtr window) {
    Guid interfaceId = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    int widgets = 0;
    EnumChildWindows(window, (child, parameter) => {
      StringBuilder name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      if (name.ToString().Contains("Chrome_RenderWidgetHostHWND")) {
        object accessible = null;
        AccessibleObjectFromWindow(child, 0xFFFFFFFC, ref interfaceId, ref accessible);
        widgets++;
      }
      return true;
    }, IntPtr.Zero);
    if (widgets == 0) {
      object accessible = null;
      AccessibleObjectFromWindow(window, 0xFFFFFFFC, ref interfaceId, ref accessible);
    }
  }
  public static void Capture(IntPtr window, string path) {
    RectangleNative rectangle;
    if (!GetWindowRect(window, out rectangle)) throw new Exception("Window bounds unavailable");
    using (Bitmap bitmap = new Bitmap(rectangle.right-rectangle.left, rectangle.bottom-rectangle.top))
    using (Graphics graphics = Graphics.FromImage(bitmap)) {
      IntPtr context = graphics.GetHdc();
      bool captured;
      try { captured = PrintWindow(window, context, 2); }
      finally { graphics.ReleaseHdc(context); }
      if (!captured) throw new Exception("Background window capture failed");
      bitmap.Save(path, ImageFormat.Png);
    }
  }
  public static void PostClick(IntPtr window, int screenX, int screenY) {
    IntPtr widget = IntPtr.Zero;
    int matches = 0;
    EnumChildWindows(window, (child, parameter) => {
      StringBuilder name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      RectangleNative rectangle;
      if (name.ToString().Contains("Chrome_RenderWidgetHostHWND") && GetWindowRect(child, out rectangle)
        && screenX >= rectangle.left && screenX < rectangle.right && screenY >= rectangle.top && screenY < rectangle.bottom) {
        widget = child;
        matches++;
      }
      return true;
    }, IntPtr.Zero);
    if (matches != 1) throw new Exception("Control does not resolve to one render widget");
    PointNative point = new PointNative { x = screenX, y = screenY };
    if (!ScreenToClient(widget, ref point) || point.x < 0 || point.y < 0 || point.x > 32767 || point.y > 32767) throw new Exception("Control position unavailable");
    IntPtr position = new IntPtr((point.y << 16) | point.x);
    if (!PostMessage(widget, 0x0200, IntPtr.Zero, position)) throw new Exception("Pointer position dispatch failed");
    System.Threading.Thread.Sleep(150);
    if (!PostMessage(widget, 0x0201, new IntPtr(1), position)) throw new Exception("Button down dispatch failed");
    System.Threading.Thread.Sleep(50);
    if (!PostMessage(widget, 0x0202, IntPtr.Zero, position)) throw new Exception("Button up dispatch failed");
  }
  public static void PostText(IntPtr window, int screenX, int screenY, string text) {
    IntPtr widget = IntPtr.Zero;
    int matches = 0;
    EnumChildWindows(window, (child, parameter) => {
      StringBuilder name = new StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      RectangleNative rectangle;
      if (name.ToString().Contains("Chrome_RenderWidgetHostHWND") && GetWindowRect(child, out rectangle)
        && screenX >= rectangle.left && screenX < rectangle.right && screenY >= rectangle.top && screenY < rectangle.bottom) { widget = child; matches++; }
      return true;
    }, IntPtr.Zero);
    if (matches != 1) throw new Exception("Text target does not resolve to one renderer");
    foreach (char character in text) {
      if (!PostMessage(widget, 0x0102, new IntPtr(character), new IntPtr(1))) throw new Exception("Text dispatch failed");
      System.Threading.Thread.Sleep(2);
    }
  }
}
'@
[void][BackgroundClaudePoc]::SetProcessDpiAwarenessContext([IntPtr](-4))
$owner = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid"
if (-not $owner -or $owner.Name -ne 'claude.exe' -or $owner.CommandLine -match '--type=') { throw 'Requested Claude main process is unavailable' }
$profileMatch = [regex]::Match($owner.CommandLine, '"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=(\S+)')
$actualProfile = @($profileMatch.Groups | Select-Object -Skip 1 | Where-Object Success | ForEach-Object Value)[0]
if (-not $actualProfile -or [IO.Path]::GetFullPath($actualProfile).TrimEnd('\') -ine [IO.Path]::GetFullPath($Profile).TrimEnd('\')) { throw 'Exact PID/profile identity mismatch' }
$foregroundBefore = [BackgroundClaudePoc]::GetForegroundWindow().ToInt64()
$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnerPid)
$windows = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ProcessId -eq $OwnerPid -and $_.Current.BoundingRectangle.Width -gt 300 -and $_.Current.BoundingRectangle.Height -gt 200 })
if ($windows.Count -eq 0) {
  $mainHandle = (Get-Process -Id $OwnerPid).MainWindowHandle
  if ($mainHandle -ne 0) {
    $mainWindow = [System.Windows.Automation.AutomationElement]::FromHandle($mainHandle)
    if ($mainWindow.Current.ProcessId -eq $OwnerPid -and $mainWindow.Current.BoundingRectangle.Width -gt 300 -and $mainWindow.Current.BoundingRectangle.Height -gt 200) { $windows = @($mainWindow) }
  }
}
if ($windows.Count -ne 1) { throw "Expected one application window; found $($windows.Count)" }
$window = $windows[0]
$windowHandle = [IntPtr]$window.Current.NativeWindowHandle
if ([BackgroundClaudePoc]::IsIconic($windowHandle)) { throw 'Window is minimized; background proof refuses to restore or activate it' }
[BackgroundClaudePoc]::Wake($windowHandle)
Start-Sleep -Milliseconds 300
$window = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
$elements = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
if ($Action -in @('Invoke','Expand','Collapse','SetValue','PostClick','PostText')) {
  if (-not $RuntimeId -or -not $ExpectedName) { throw 'An observed runtime ID and exact expected name are required' }
  $matches = @($elements | Where-Object { (($_.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.') -eq $RuntimeId })
  if ($matches.Count -ne 1) { throw 'Observed control no longer resolves exactly once' }
  $element = $matches[0]
  if ($element.Current.Name -cne $ExpectedName -or -not $element.Current.IsEnabled) { throw 'Observed control changed or is disabled' }
  switch ($Action) {
    'Invoke' { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
    'Expand' { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
    'Collapse' { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() }
    'SetValue' { $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value) }
    'PostClick' {
      $bounds = $element.Current.BoundingRectangle
      if ($bounds.IsEmpty -or $bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Observed control has no bounds' }
      [BackgroundClaudePoc]::PostClick($windowHandle, [int]($bounds.X + $bounds.Width/2), [int]($bounds.Y + $bounds.Height/2))
    }
    'PostText' {
      if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { throw 'Text target is not an editor' }
      $textPattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not [string]::IsNullOrWhiteSpace($textPattern.Current.Value)) { throw 'Text target is not empty' }
      $bounds = $element.Current.BoundingRectangle
      [BackgroundClaudePoc]::PostClick($windowHandle, [int]($bounds.X + $bounds.Width/2), [int]($bounds.Y + $bounds.Height/2))
      Start-Sleep -Milliseconds 150
      [BackgroundClaudePoc]::PostText($windowHandle, [int]($bounds.X + $bounds.Width/2), [int]($bounds.Y + $bounds.Height/2), $Value)
    }
  }
  Start-Sleep -Milliseconds 800
  [BackgroundClaudePoc]::Wake($windowHandle)
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
  $elements = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
}
$controls = @($elements | Where-Object { $_.Current.ControlType.ProgrammaticName -in @('ControlType.Button','ControlType.MenuItem','ControlType.Edit','ControlType.TabItem','ControlType.ComboBox','ControlType.RadioButton','ControlType.ListItem') } | ForEach-Object {
  [pscustomobject]@{id=(($_.GetRuntimeId() | ForEach-Object { [string]$_ }) -join '.');name=$_.Current.Name;type=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled;patterns=@($_.GetSupportedPatterns() | ForEach-Object ProgrammaticName)}
})
if ($Screenshot) { [BackgroundClaudePoc]::Capture($windowHandle, [IO.Path]::GetFullPath($Screenshot)) }
$foregroundAfter = [BackgroundClaudePoc]::GetForegroundWindow().ToInt64()
[pscustomobject]@{ownerPid=$OwnerPid;profile=$actualProfile;window=$windowHandle.ToInt64();action=$Action;foregroundBefore=$foregroundBefore;foregroundAfter=$foregroundAfter;foregroundUnchanged=($foregroundBefore -eq $foregroundAfter);screenshot=$Screenshot;controls=$controls} | ConvertTo-Json -Depth 6 -Compress
