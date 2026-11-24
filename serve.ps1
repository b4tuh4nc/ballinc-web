# Simple HTTP Server for Ballinc Web in PowerShell
param (
    [int]$Port = 8080,
    [string]$Root = "$PSScriptRoot\web"
)

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
} catch {
    Write-Error "Failed to start listener on $prefix : $_"
    exit 1
}

Write-Host "=========================================="
Write-Host "Ballinc Web Server running at: $prefix"
Write-Host "Serving files from: $Root"
Write-Host "Press Ctrl+C to stop."
Write-Host "=========================================="

$mimeTypes = @{
    ".html"  = "text/html; charset=utf-8"
    ".htm"   = "text/html; charset=utf-8"
    ".js"    = "application/javascript; charset=utf-8"
    ".css"   = "text/css; charset=utf-8"
    ".json"  = "application/json; charset=utf-8"
    ".png"   = "image/png"
    ".jpg"   = "image/jpeg"
    ".jpeg"  = "image/jpeg"
    ".gif"   = "image/gif"
    ".svg"   = "image/svg+xml"
    ".ico"   = "image/x-icon"
    ".woff"  = "font/woff"
    ".woff2" = "font/woff2"
    ".ttf"   = "font/ttf"
    ".txt"   = "text/plain; charset=utf-8"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        # Add basic CORS headers
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "*")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 204
            $response.Close()
            continue
        }

        # Resolve requested file path (strip query parameters)
        $rawPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
        if ([string]::IsNullOrWhiteSpace($rawPath)) {
            $rawPath = "index.html"
        }

        # Normalize directory separators
        $normalizedRelativePath = $rawPath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $targetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $normalizedRelativePath))
        $canonicalRoot = [System.IO.Path]::GetFullPath($Root)

        # Security check: prevent directory traversal
        if (-not $targetPath.StartsWith($canonicalRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $response.StatusCode = 403
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden")
            $response.ContentType = "text/plain"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if (Test-Path $targetPath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($targetPath).ToLower()
            $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            
            try {
                $fileBytes = [System.IO.File]::ReadAllBytes($targetPath)
                $response.ContentType = $contentType
                $response.ContentLength64 = $fileBytes.Length
                $response.StatusCode = 200

                if ($request.HttpMethod -ne "HEAD") {
                    $response.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
                }
            } catch {
                $response.StatusCode = 500
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes("500 Internal Server Error: $_")
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
            }
        } else {
            $response.StatusCode = 404
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rawPath")
            $response.ContentType = "text/plain"
            $response.ContentLength64 = $errBytes.Length
            $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }

        $response.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
