# MCPM

MCPM to prosty menedżer modów Minecraft korzystający z API Modrinth.

## Wymagania

- Node.js 18 lub nowszy

## Użycie

```text
mcpm init
mcpm search <fraza>
mcpm install <slug>
mcpm remove <slug>
mcpm update
mcpm upgrade <wersja>
mcpm list
```

`update` aktualizuje wszystkie bezpośrednio zadeklarowane mody dla bieżącej
wersji Minecrafta.

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
