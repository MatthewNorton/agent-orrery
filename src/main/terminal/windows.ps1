$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs') -ReferencedAssemblies @(
        'System.dll',
        ([System.Windows.Automation.AutomationElement]).Assembly.Location,
        ([System.Windows.Automation.ControlType]).Assembly.Location,
        ([System.Windows.Point]).Assembly.Location
    )
    # Security: stdin is data, never evaluated as a command or script.
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $owners = @()
    foreach ($candidate in $request.candidates) {
        if ([Orrery.TerminalFocus]::Matches([int]$candidate.pid, [string]$request.provider,
                [double]$candidate.startedAt, 0)) {
            $owners += [int]$candidate.pid
        }
    }
    if ($owners.Count -eq 0) {
        foreach ($owner in [Orrery.TerminalFocus]::FileOwners([string]$request.transcriptPath)) {
            if ([Orrery.TerminalFocus]::Matches($owner.Pid, [string]$request.provider, 0, $owner.Start)) {
                $owners += $owner.Pid
            }
        }
    }
    $owners = @($owners | Select-Object -Unique)
    if ($owners.Count -gt 1) { [Console]::WriteLine('AMBIGUOUS') }
    elseif ($owners.Count -eq 1) { [Console]::WriteLine([Orrery.TerminalFocus]::Focus($owners[0])) }
    else { [Console]::WriteLine('NOT_FOUND') }
} catch {
    [Console]::WriteLine('NOT_FOUND')
}
