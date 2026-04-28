$scriptDir = Split-Path $MyInvocation.MyCommand.Definition -Parent
$nodeExe = Join-Path $scriptDir 'node.exe'

if (Test-Path $nodeExe) {
  if ($MyInvocation.ExpectingInput) {
    $input | & $nodeExe (Join-Path $scriptDir 'mock-codebuddy.js') $args
  } else {
    & $nodeExe (Join-Path $scriptDir 'mock-codebuddy.js') $args
  }
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & node (Join-Path $scriptDir 'mock-codebuddy.js') $args
  } else {
    & node (Join-Path $scriptDir 'mock-codebuddy.js') $args
  }
}

exit $LASTEXITCODE
