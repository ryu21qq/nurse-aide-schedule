param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataFile = Join-Path $RootDir "schedule_data.json"

$MimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

function Send-HttpResponse {
    param(
        [System.IO.Stream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [string]$ContentType,
        [byte[]]$BodyBytes
    )
    $header = "HTTP/1.1 $StatusCode $StatusText`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($BodyBytes.Length)`r`n" +
              "Access-Control-Allow-Origin: *`r`n" +
              "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
              "Access-Control-Allow-Headers: Content-Type`r`n" +
              "Cache-Control: no-cache`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($BodyBytes.Length -gt 0) {
        $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
    }
    $Stream.Flush()
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  ナースエイド勤務表アプリ 外部アクセス用サーバー起動完了" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  このPCからアクセス   : http://localhost:$Port" -ForegroundColor Yellow
Write-Host "  外部端末からアクセス : http://192.168.10.182:$Port" -ForegroundColor Green
Write-Host "  データ保存先         : $DataFile"
Write-Host "============================================================" -ForegroundColor Cyan

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 5000
            $stream = $client.GetStream()

            # Read HTTP request header
            $buffer = New-Object byte[] 65536
            $ms = New-Object System.IO.MemoryStream
            $headerEndIndex = -1

            while ($true) {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $ms.Write($buffer, 0, $read)
                $allBytes = $ms.ToArray()
                $textSoFar = [System.Text.Encoding]::ASCII.GetString($allBytes)
                $idx = $textSoFar.IndexOf("`r`n`r`n")
                if ($idx -ge 0) {
                    $headerEndIndex = $idx + 4
                    break
                }
            }

            if ($headerEndIndex -lt 0) {
                $client.Close()
                continue
            }

            $allBytes = $ms.ToArray()
            $headerText = [System.Text.Encoding]::ASCII.GetString($allBytes, 0, $headerEndIndex)
            $lines = $headerText -split "`r`n"
            $requestLine = $lines[0] -split " "
            $method = $requestLine[0]
            $rawPath = $requestLine[1]

            # Parse Content-Length if POST
            $contentLength = 0
            foreach ($line in $lines) {
                if ($line -match "^Content-Length:\s*(\d+)") {
                    $contentLength = [int]$Matches[1]
                }
            }

            $bodyAlreadyRead = $allBytes.Length - $headerEndIndex
            while ($bodyAlreadyRead -lt $contentLength) {
                $read = $stream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) { break }
                $ms.Write($buffer, 0, $read)
                $bodyAlreadyRead += $read
            }

            $fullBytes = $ms.ToArray()
            $bodyBytes = New-Object byte[] $contentLength
            if ($contentLength -gt 0) {
                [System.Array]::Copy($fullBytes, $headerEndIndex, $bodyBytes, 0, $contentLength)
            }

            $cleanPath = ($rawPath -split "\?")[0]
            $cleanPath = [System.Uri]::UnescapeDataString($cleanPath)

            if ($method -eq "OPTIONS") {
                Send-HttpResponse -Stream $stream -StatusCode 200 -StatusText "OK" -ContentType "text/plain" -BodyBytes ([byte[]]@())
            }
            elseif ($cleanPath -eq "/api/data" -and $method -eq "GET") {
                if (Test-Path $DataFile) {
                    $jsonBytes = [System.IO.File]::ReadAllBytes($DataFile)
                    Send-HttpResponse -Stream $stream -StatusCode 200 -StatusText "OK" -ContentType "application/json; charset=utf-8" -BodyBytes $jsonBytes
                } else {
                    $emptyBytes = [System.Text.Encoding]::UTF8.GetBytes("null")
                    Send-HttpResponse -Stream $stream -StatusCode 200 -StatusText "OK" -ContentType "application/json; charset=utf-8" -BodyBytes $emptyBytes
                }
            }
            elseif ($cleanPath -eq "/api/data" -and $method -eq "POST") {
                [System.IO.File]::WriteAllBytes($DataFile, $bodyBytes)
                $okBytes = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true}')
                Send-HttpResponse -Stream $stream -StatusCode 200 -StatusText "OK" -ContentType "application/json; charset=utf-8" -BodyBytes $okBytes
            }
            else {
                if ($cleanPath -eq "/" -or $cleanPath -eq "") {
                    $cleanPath = "/index.html"
                }
                $relPath = $cleanPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
                $targetFile = Join-Path $RootDir $relPath

                if ((Test-Path $targetFile -PathType Leaf) -and $targetFile.StartsWith($RootDir)) {
                    $ext = [System.IO.Path]::GetExtension($targetFile).ToLower()
                    $mime = $MimeTypes[$ext]
                    if (-not $mime) { $mime = "application/octet-stream" }
                    $fileBytes = [System.IO.File]::ReadAllBytes($targetFile)
                    Send-HttpResponse -Stream $stream -StatusCode 200 -StatusText "OK" -ContentType $mime -BodyBytes $fileBytes
                } else {
                    $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                    Send-HttpResponse -Stream $stream -StatusCode 404 -StatusText "Not Found" -ContentType "text/plain; charset=utf-8" -BodyBytes $notFound
                }
            }
        } catch {
            # Ignore client disconnect errors
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
