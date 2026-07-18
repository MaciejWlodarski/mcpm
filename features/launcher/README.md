# @mcpm/feature-launcher

Opcjonalny feature MCPM przygotowujący bezpośrednie uruchamianie Minecrafta.

Aktualny etap udostępnia:

```text
mcpm launcher status
mcpm launcher login
mcpm launcher account
mcpm launcher account --refresh
mcpm launcher logout
```

`login` używa kodu urządzenia Microsoft, a następnie wymienia token przez Xbox Live,
XSTS i Minecraft Services. Konto jest wspólne dla wszystkich projektów MCPM. Token
odświeżania i sesja Minecraft są szyfrowane na Windows mechanizmem DPAPI dla
bieżącego użytkownika.

Client ID aplikacji MCPM jest publiczny. Podczas developmentu można go zastąpić
zmienną `MCPM_MICROSOFT_CLIENT_ID`.

Minecraft Services ręcznie dopuszcza nowe aplikacje klienckie. Przed pierwszym
użyciem App ID musi zostać zaakceptowane przez formularz przeglądu Java Edition:
`https://aka.ms/mce-reviewappid`. Bez wpisu na allowliście końcowa wymiana tokenu
zwróci `Invalid app registration`, mimo poprawnego logowania Microsoft i Xbox.

Kolejne etapy obejmą pobieranie runtime’u i właściwe polecenie `mcpm launch`.
