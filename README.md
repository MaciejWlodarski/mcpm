# MCPM

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
