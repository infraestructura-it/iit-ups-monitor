<#
  Metodología IIT: crea el directorio del proyecto, extrae los archivos descargados de Claude,
  inicia git y crea el repositorio en la organización de GitHub.

  Uso (desde la carpeta Descargas):
    powershell -ExecutionPolicy Bypass -File .\setup-repo.ps1
    powershell -ExecutionPolicy Bypass -File .\setup-repo.ps1 -Visibilidad public
#>
param(
  [string]$Nombre = "iit-ups-monitor",
  [string]$Org = "infraestructura-it",
  [ValidateSet("private", "public")][string]$Visibilidad = "private",
  [string]$Base = ""
)
$ErrorActionPreference = "Stop"
function Paso($m) { Write-Host "==> $m" -ForegroundColor Cyan }
# Ejecuta un comando nativo en silencio y devuelve su código de salida (compatible con PowerShell 5.1)
function Nativo([scriptblock]$b) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  & $b 2>&1 | Out-Null; $code = $LASTEXITCODE
  $ErrorActionPreference = $prev; return $code
}

# Requisitos
foreach ($t in "git", "gh") {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "No encuentro '$t' en el PATH." }
}
if ((Nativo { gh auth status }) -ne 0) { throw "GitHub CLI sin sesión. Ejecuta: gh auth login" }

# Rutas (funciona en Infraestructura02 y en Estacion01 porque usa el perfil activo)
$Descargas = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
if (-not $Base) { $Base = Join-Path $env:USERPROFILE "OneDrive\2026-proyectos" }
if (-not (Test-Path $Base)) { $Base = Read-Host "No existe $Base. Escribe la ruta base de proyectos" }
$Destino = Join-Path $Base $Nombre
$Zip = Join-Path $Descargas "$Nombre.zip"
Paso "Perfil: $env:USERNAME | Destino: $Destino"

if (-not (Test-Path $Zip)) { throw "No encuentro $Zip. Descarga el .zip desde Claude primero." }
if ((Test-Path $Destino) -and (Get-ChildItem $Destino -Force | Select-Object -First 1)) {
  throw "$Destino ya existe y no está vacío. Bórralo o usa -Nombre distinto."
}

Paso "Creando directorio y extrayendo archivos"
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
$Tmp = Join-Path $env:TEMP "$Nombre-$(Get-Random)"
Expand-Archive -Path $Zip -DestinationPath $Tmp -Force
$Raiz = if (Test-Path (Join-Path $Tmp $Nombre)) { Join-Path $Tmp $Nombre } else { $Tmp }
Copy-Item -Path (Join-Path $Raiz "*") -Destination $Destino -Recurse -Force
Remove-Item $Tmp -Recurse -Force

Set-Location $Destino
Paso "Iniciando repositorio git"
git init -b main | Out-Null
git config core.autocrlf false
git add -A
git commit -m "Estructura inicial: capas edge (Raspberry Pi 5), web local, nube Supabase" | Out-Null

Paso "Creando $Org/$Nombre ($Visibilidad) en GitHub"
if ((Nativo { gh repo view "$Org/$Nombre" }) -eq 0) {
  Write-Host "   El repo ya existe, solo se enlaza y se sube." -ForegroundColor Yellow
  git remote add origin "https://github.com/$Org/$Nombre.git"
  git push -u origin main
} else {
  gh repo create "$Org/$Nombre" "--$Visibilidad" --source . --remote origin --push `
    --description "Monitoreo web de UPS por RS232/USB con Raspberry Pi 5: capa local, dashboard y nube Supabase"
}

Paso "Listo"
Write-Host "   Local:  $Destino"
Write-Host "   GitHub: https://github.com/$Org/$Nombre"
Write-Host "   Prueba: cd edge; npm install; npm run sim   (http://localhost:8080)"
