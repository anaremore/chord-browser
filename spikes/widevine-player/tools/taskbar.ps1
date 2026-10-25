# Lists the taskbar's buttons by name, through UI Automation (no capture):
# shows whether a window has a taskbar button, and how windows are grouped.
#   pwsh tools/taskbar.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$trayCondition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $trayCondition)
if (-not $tray) { '{"error":"no Shell_TrayWnd"}'; exit 0 }
$buttonCondition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
$names = @()
foreach ($b in $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)) {
  $names += $b.Current.Name
}
[pscustomobject]@{ buttons = $names } | ConvertTo-Json -Compress
