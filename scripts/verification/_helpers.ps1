# Shared helpers for scripts/verification/milestone-*.ps1 self-checks.
# Keep every verification script ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$ErrorActionPreference = 'Continue'
$script:Results = New-Object System.Collections.Generic.List[object]
$script:CaseFailures = $null
$script:CaseNotes = $null

function Invoke-Pnpm {
    param([string[]]$Arguments)
    # Splat (@Arguments): pnpm is often a pnpm.ps1 shim, and passing $Arguments unsplatted to a
    # PowerShell script delivers the whole array as ONE space-joined argument.
    $lines = & pnpm @Arguments 2>&1 | ForEach-Object { "$_" }
    [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

function Invoke-DataForge {
    param([string[]]$Arguments)
    Invoke-Pnpm (@('--silent', 'dataforge') + $Arguments)
}

function Get-Sha256 {
    param([string]$Path)
    (Get-FileHash -Algorithm SHA256 -Path $Path).Hash
}

function Assert-That {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { $script:CaseFailures.Add($Message) }
}

function Assert-Match {
    param([string]$Text, [string]$Pattern, [string]$What)
    Assert-That ($Text -match $Pattern) "$What - output does not match /$Pattern/"
}

function Assert-Exit {
    param($Result, [int]$Expected, [string]$What)
    Assert-That ($Result.Code -eq $Expected) "$What - exit code $($Result.Code), expected $Expected"
}

function Write-Note {
    param([string]$Message)
    $script:CaseNotes.Add($Message)
}

function Test-Case {
    param([string]$Id, [string]$Title, [scriptblock]$Body, [switch]$Skip)
    if ($Skip) {
        $script:Results.Add([pscustomobject]@{ Id = $Id; Title = $Title; Status = 'SKIP' })
        Write-Host ('{0,-8} SKIP  {1}' -f $Id, $Title)
        return
    }
    $script:CaseFailures = New-Object System.Collections.Generic.List[string]
    $script:CaseNotes = New-Object System.Collections.Generic.List[string]
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Body
    } catch {
        $script:CaseFailures.Add("threw: $($_.Exception.Message)")
    }
    $status = if ($script:CaseFailures.Count -eq 0) { 'PASS' } else { 'FAIL' }
    $script:Results.Add([pscustomobject]@{ Id = $Id; Title = $Title; Status = $status })
    Write-Host ('{0,-8} {1}  {2}  ({3:N1} s)' -f $Id, $status, $Title, $watch.Elapsed.TotalSeconds)
    foreach ($note in $script:CaseNotes) { Write-Host "                 $note" }
    foreach ($failure in $script:CaseFailures) { Write-Host "                 - $failure" }
}

function Complete-Verification {
    param([string]$Milestone)
    $failed = @($script:Results | Where-Object { $_.Status -eq 'FAIL' }).Count
    $passed = @($script:Results | Where-Object { $_.Status -eq 'PASS' }).Count
    $skipped = @($script:Results | Where-Object { $_.Status -eq 'SKIP' }).Count
    Write-Host ''
    Write-Host ("$Milestone self-check: $passed passed, $failed failed, $skipped skipped " +
        "(PowerShell $($PSVersionTable.PSVersion))")
    if ($failed -gt 0) { exit 1 }
    exit 0
}
