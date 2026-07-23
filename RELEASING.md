# OpenScreen veröffentlichen

Git-Tags für Releases nicht manuell anlegen. `npm version` aktualisiert
`package.json` und `package-lock.json`, erstellt den Release-Commit und setzt den
passenden Tag.

## Release-Ablauf

1. Alle Änderungen committen:

   ```bash
   git status
   git add <dateien>
   git commit -m "Beschreibung der Änderung"
   ```

2. Tests und Produktions-Build prüfen:

   ```bash
   npm test
   npm run build-vite
   ```

3. Release-Version erhöhen:

   ```bash
   npm version patch -m "release v%s"
   ```

   Je nach Art des Releases:

   ```bash
   npm version patch   # 1.6.1 -> 1.6.2: Bugfix
   npm version minor   # 1.6.1 -> 1.7.0: neue Features
   npm version major   # 1.6.1 -> 2.0.0: inkompatible Änderungen
   ```

4. Linux-Pakete bauen:

   ```bash
   npm run build:linux
   ```

5. Release-Commit und Tag veröffentlichen:

   ```bash
   git push origin main --follow-tags
   ```

## Wichtig

- Vor `npm version` muss der Arbeitsbaum sauber sein.
- Keinen separaten `git tag`-Befehl ausführen.
- `npm run version:sync` ist kein Release-Befehl. Er gleicht lediglich die
  Version in `package-lock.json` an `package.json` an.
- Erst pushen, wenn Tests und Paket-Build erfolgreich waren.

Kurzform:

```text
Änderungen committen -> testen -> npm version patch/minor/major
-> npm run build:linux -> git push origin main --follow-tags
```
