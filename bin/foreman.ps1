#!/usr/bin/env pwsh
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $ScriptDir "..\foreman.mjs") @args
