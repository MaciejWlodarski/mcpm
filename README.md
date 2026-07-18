# MCPM

MCPM is an open-source command-line package manager for Minecraft: Java Edition
mod projects. It manages mods through the Modrinth API and is being extended with
an optional direct launcher feature.

> **Project status:** mod management is functional. Direct Microsoft account
> authentication is implemented, but the MCPM App ID is awaiting approval for
> access to the Minecraft Services API. MCPM does not attempt to bypass that
> review process.

## Application information

- **Application name:** MCPM Launcher
- **Owner and publisher:** Maciej Wlodarski (`MaciejWlodarski`)
- **Microsoft Application (client) ID:** `51b43610-2c23-4923-8378-e2a011ed16e4`
- **Platform:** open-source Windows CLI; the launcher is an optional MCPM feature
- **License:** MIT
- **Source:** this repository

### Purpose

The optional launcher is intended to let users authenticate their own licensed
Minecraft: Java Edition account and eventually start the Minecraft version and
mod loader configured by their local MCPM project. It is not an account linking,
verification, resale, credential collection, or hosted authentication service.

### Microsoft and Minecraft authentication

MCPM uses Microsoft OAuth 2.0 Device Code Flow as a public client. It requests
only `XboxLive.signin` and `XboxLive.offline_access`. Users enter the code on
Microsoft's website; MCPM never displays, receives, or stores their password.

After Microsoft authorization, MCPM performs the standard local authentication
chain:

1. Microsoft OAuth access and refresh token
2. Xbox Live user token
3. Xbox Secure Token Service (XSTS) token
4. Minecraft Services access token
5. Minecraft entitlement and profile lookup

The implementation is available in
[`features/launcher/src/auth.js`](features/launcher/src/auth.js). There is no MCPM
authentication server and tokens are never sent to the project owner or any
MCPM-controlled service.

### Privacy and token storage

- Authentication data remains on the user's computer.
- On Windows, the complete saved session is encrypted with DPAPI using the
  `CurrentUser` scope before it is written to disk.
- Atomic file replacement prevents partially written credential files.
- `mcpm launcher logout` deletes the saved session.
- MCPM does not collect analytics, passwords, email addresses, access tokens, or
  refresh tokens.
- Network requests are made only to Microsoft, Xbox Live, Minecraft Services,
  Modrinth, and download URLs selected from Modrinth metadata.

The encrypted storage implementation is available in
[`features/launcher/src/secure-storage.js`](features/launcher/src/secure-storage.js).
New App IDs must be manually approved by Minecraft Services through the official
[Java Edition application review process](https://aka.ms/mce-reviewappid).

### Current launcher commands

```text
mcpm feature install launcher
mcpm launcher login
mcpm launcher account
mcpm launcher account --refresh
mcpm launcher logout
mcpm launcher status
```

The runtime downloader and final game launch command are not implemented yet.

## Dokumentacja po polsku

MCPM to prosty menedżer modów Minecraft korzystający z API Modrinth.

## Wymagania

- Node.js 18 lub nowszy

## Instalacja polecenia globalnego

W katalogu repozytorium uruchom:

```text
npm install
npm link
```

Po `npm link` polecenie `mcpm` jest dostępne w terminalu niezależnie od
bieżącego katalogu. Link wskazuje na ten katalog roboczy, więc kolejne lokalne
zmiany kodu nie wymagają ponownej instalacji.

## Użycie

```text
mcpm init
mcpm use <nazwa-lub-ścieżka>
mcpm projects
mcpm current
mcpm forget <nazwa-lub-ścieżka>
mcpm config
mcpm config --beta on
mcpm config --beta off
mcpm search <fraza>
mcpm install <slug>
mcpm remove <slug>
mcpm update
mcpm upgrade <wersja>
mcpm list
```

## Projekty i uruchamianie z dowolnego katalogu

Każdy projekt utworzony przez `mcpm init` jest automatycznie rejestrowany i
ustawiany jako aktywny. Dzięki temu pozostałe polecenia można uruchamiać z
dowolnego katalogu.

```text
mcpm projects
mcpm use moj-modpack
mcpm use D:\Minecraft\modpacks\survival
```

`projects` pokazuje wszystkie znane projekty i oznacza aktywny zieloną kropką.
`use` przełącza aktywny projekt; podanie ścieżki do nowego projektu jednocześnie
go rejestruje. `current` pokazuje projekt, którego faktycznie użyje bieżący
katalog. `forget` usuwa wyłącznie wpis z globalnego rejestru — nie usuwa
konfiguracji, lockfile ani modów.

Jeżeli polecenie zostanie uruchomione wewnątrz katalogu projektu MCPM lub jego
podkatalogu, lokalny projekt ma pierwszeństwo przed globalnie aktywnym. Można też
jednorazowo wymusić projekt zmienną środowiskową `MCPM_PROJECT`; ma ona najwyższy
priorytet.

Rejestr jest przechowywany w `~/.mcpm/projects.json`. Na potrzeby automatyzacji
lokalizację katalogu stanu można zmienić przez `MCPM_STATE_DIR`.

## Wersje beta

Ustawienie beta jest zapisywane osobno dla każdego projektu. Nie trzeba dodawać
`--beta` do każdego polecenia:

```text
mcpm use moj-modpack
mcpm config --beta on
mcpm update
```

Aktualną wartość można sprawdzić przez `mcpm config`. `--beta` przy `install`,
`update` lub `upgrade` nadal pozwala jednorazowo dopuścić bety w projekcie, który
ma je domyślnie wyłączone.

## Opcjonalne feature’y

Cięższe funkcje mogą być instalowane niezależnie od podstawowego MCPM:

```text
mcpm feature list
mcpm feature install launcher
mcpm launcher status
mcpm launcher login
mcpm launcher account
mcpm launcher logout
mcpm feature uninstall launcher
```

Feature `launcher` jest osobnym pakietem `@mcpm/feature-launcher`, ładowanym
dynamicznie z `~/.mcpm/features`. Launcher udostępnia diagnostykę aktywnego projektu
oraz logowanie kodem urządzenia przez Microsoft, Xbox Live i Minecraft Services.
Sesja konta jest globalna dla MCPM i na Windows szyfrowana przez DPAPI. Pobieranie
runtime’u oraz właściwe `mcpm launch` będą dodawane w kolejnych etapach.

Nowe App ID wymagają ręcznego dopuszczenia przez Minecraft Services. Formularz
przeglądu aplikacji Java Edition jest dostępny pod `https://aka.ms/mce-reviewappid`.

`update` aktualizuje wszystkie bezpośrednio zadeklarowane mody dla bieżącej
wersji Minecrafta. Każdy mod jest przetwarzany osobno: brak kompatybilnej wersji
jednego moda zostanie pokazany w podsumowaniu, ale nie zatrzyma aktualizacji
pozostałych.

`upgrade <wersja>` zmienia wersję Minecrafta i przygotowuje cały kompatybilny
zestaw modów przed zastąpieniem istniejących plików.

Flaga `--beta` pozwala używać wydań beta. Wydania alpha nie są instalowane
automatycznie.

## Bezpieczeństwo zmian

Pobierane pliki trafiają najpierw do katalogu tymczasowego. MCPM zastępuje stare
pliki i zapisuje `mcpm.json` oraz `mcpm-lock.json` dopiero po przygotowaniu całego
planu. W przypadku błędu przywraca poprzednie pliki i stan projektu.

Wymagana zależność nie może zostać usunięta. Jeżeli była także zainstalowana
bezpośrednio, `remove` jedynie zmienia ją z powrotem w zależność.

## Rozwój

```text
npm test
npm run check
```
