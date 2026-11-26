# PrediMaint — exécution et guide de validation

Ce guide décrit le socle IoT existant et le parcours Technicien ajouté progressivement : acquisition, MQTT, stockage, alertes, interventions, permissions, mesures, notifications, calibration et consultation hors ligne.

## Découpage des releases

| Release | PBI | Points | État de la documentation |
|---|---:|---:|---|
| Release 1 | 9 | 44 | Détaillé ci-dessous |
| Espace Technicien | — | — | Tableau de bord et parcours connecté aux données réelles |
| Sécurité des comptes | — | — | Réinitialisation commune aux acteurs, jetons à usage unique et révocation des sessions |

## Release 1 — périmètre

| Réf. | User story | Livraison de ce release |
|---|---|---|
| US-18 | Collecte des mesures des capteurs | Le firmware MicroPython acquiert DHT22 et HW-072, calcule le taux d’événements par fenêtre et publie un message JSON. Le courant reste simulé tant que le câblage ACS712 n’est pas protégé et calibré. |
| US-19 | Stockage des mesures | Le backend valide le JSON MQTT, ajoute l’horodatage serveur UTC et conserve les mesures dans PostgreSQL avec index machine/date. |
| US-20 | Détection de dépassement de seuil | Seuils avertissement/critique par machine et grandeur ; création/mise à jour d’une alerte active, puis clôture automatique au retour sous le seuil d’avertissement. |
| US-23 | Déclaration des machines et capteurs | Le Responsable peut déclarer des machines et leurs capteurs, modifier les métadonnées, désactiver/réactiver un capteur et archiver/réactiver une machine sans effacer son historique. |
| US-41 | Sécurité des échanges MQTT | Connexion par mot de passe, compte distinct pour le firmware et le backend, accès anonyme interdit, ACL limitant un équipement à ses topics et backend en lecture seule sur les topics de télémétrie/état. |
| US-42 | Sécurité de l’API | Jetons JWT expirables, hachage des mots de passe, contrôle des rôles côté serveur, validation des entrées et tests d’accès non autorisé. |
| US-47 | Dépôt Git et tableau Trello | Dépôt Git local, règles d’exclusion des secrets, procédure de branches/commits et modèle de board avec les neuf cartes Release 1 dans `docs/releases/release-1/trello-board.md`. La création du board dans un compte Trello reste une action manuelle. |
| US-48 | Installation du broker MQTT | Mosquitto est déployé par Docker Compose, persistant, authentifié, protégé par ACL et vérifié par healthcheck. Port hôte 1884, port interne Docker 1883. |
| US-49 | Firmware ESP32 de base | Connexion Wi-Fi, reconnexion, DHT22, comptage d’événements HW-072 par interruption, Last Will MQTT et publication QoS 1 toutes les cinq secondes. |

## Architecture et ports

```text
DHT22 + HW-072 + ACS712 (désactivé/simulé)
              ↓ MicroPython / JSON
ESP32 ── MQTT 1884 (hôte) → Mosquitto 1883 (Docker)
                                  ↓ MQTT interne
                             FastAPI → PostgreSQL
                                  ↓ HTTP JSON, polling 5 s
                              Interface web :8001
```

| Service | Adresse depuis le PC | Adresse interne Docker |
|---|---|---|
| Application/API | `http://localhost:8001` | `backend:8000` |
| MQTT | `PC_IP:1884` | `mosquitto:1883` |
| PostgreSQL | non exposé sur le PC | `postgres:5432` |

Le backend horodate chaque mesure à réception. Le navigateur actualise par polling HTTP toutes les cinq secondes ; MQTT transporte les mesures de l’ESP32 au backend. Le port PostgreSQL n’est pas publié sur le réseau de l’hôte.

## Préparer et démarrer

### Configuration des secrets

1. Depuis PowerShell, place-toi dans le dossier du dépôt.
2. Si `.env` n’existe pas, copie `.env.example` vers `.env`.
3. Renseigne des secrets différents et robustes pour PostgreSQL, JWT, les comptes MQTT et tous les comptes de démonstration, notamment `DEMO_ADMIN_PASSWORD`. Remplace les valeurs d'exemple avant le premier démarrage. Ne colle jamais les vrais secrets dans `config.example.json` ni dans Git.
4. `MQTT_USERNAME` / `MQTT_PASSWORD` sont ceux de l’ESP32. `MQTT_BACKEND_USERNAME` / `MQTT_BACKEND_PASSWORD` sont générés pour l’abonné backend. Le nom `predimaint_backend` est utilisé par l’ACL.
5. L’URL `DATABASE_URL` doit employer les mêmes identifiants PostgreSQL que `POSTGRES_USER`, `POSTGRES_PASSWORD` et `POSTGRES_DB`. Encoder les caractères spéciaux du mot de passe dans l’URL.
6. Pour envoyer les notifications de modification de compte avec Brevo, crée une clé **SMTP** dans Brevo (une clé API n'est pas un mot de passe SMTP), puis configure localement les variables suivantes dans `.env` :

   ```dotenv
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_USERNAME=<identifiant SMTP affiché dans Brevo>
   SMTP_PASSWORD=<clé SMTP Brevo>
   SMTP_FROM_EMAIL=<adresse expéditrice vérifiée dans Brevo>
   SMTP_USE_TLS=true
   PUBLIC_BASE_URL=http://localhost:8001
   ```

   `SMTP_USE_TLS=true` active STARTTLS sur le port 587. Vérifiez que l'expéditeur est autorisé/vérifié dans Brevo et que l'identifiant SMTP correspond exactement à celui affiché dans ses paramètres SMTP. Pour un accès depuis un autre appareil, remplacez `PUBLIC_BASE_URL` par une adresse joignable ; en production, utilisez HTTPS. Gardez la clé SMTP uniquement dans `.env` ; ne la collez ni dans le code ni dans Git. Après une modification de `.env`, recréez le backend avec `docker compose up -d --force-recreate backend`. Sans SMTP configuré, les notifications de modification de compte restent visibles dans l'espace du compte et au centre administrateur ; aucun lien de récupération ne peut être envoyé.

Les ports hôte peuvent être changés via `MQTT_HOST_PORT` et `API_HOST_PORT`. Le firmware doit alors utiliser `mqtt_port` égal à `MQTT_HOST_PORT`.

### Lancer les services

```powershell
docker compose up --build
```

Laisse cette fenêtre ouverte. Ouvre `http://localhost:8001`. Pour lancer en arrière-plan : `docker compose up -d --build`; état : `docker compose ps`; journaux : `docker compose logs -f backend mosquitto postgres`; arrêt : `docker compose down`. N’utilise pas `docker compose down -v` sauf si tu veux supprimer aussi les mesures conservées dans le volume PostgreSQL.

### Charger le firmware

1. Dans Thonny, sélectionne MicroPython ESP32 et le port USB de la carte.
2. Copie `firmware/config.example.json` vers l’ESP32 en `/config.json`, puis renseigne le SSID/mot de passe Wi-Fi, `mqtt_host` (IPv4 du PC), `mqtt_port` (1884 par défaut), identifiants de l’appareil et `machine_id` (`demo-machine`).
3. Enregistre `firmware/main.py` sur l’ESP32 en `/main.py` et lance-le avec F5. `umqtt.simple` doit être présent.
4. La console doit afficher `Wi-Fi connecté`, puis `Publié: {...}`.

**Sécurité électrique :** le firmware conserve `current_mode` à `simulated`. Ne raccorde pas la sortie ACS712 directement à GPIO34 lorsque le module est alimenté en 5 V. L’activation matérielle attend le pont diviseur vérifié et un calibrage. Ne branche pas le secteur sur la breadboard.

## Comptes initiaux et rôles

Les comptes initiaux sont créés au premier démarrage, selon les mots de passe définis dans `.env` :

| Adresse | Rôle | Permissions Release 1 |
|---|---|---|
| `tech@predimaint.local` | Technicien | Consultation, acquittement/clôture d’alertes et enregistrement d’intervention via API |
| `manager@predimaint.local` | Responsable | Permissions technicien, gestion machines/capteurs/seuils et ingestion HTTP de test |
| `director@predimaint.local` | Direction | Consultation en lecture seule |
| `admin@predimaint.local` | Administrateur système | Gestion des utilisateurs, rôles, profil, paramètres, notifications et journaux |

Le mot de passe administrateur de développement par défaut est `change-admin-password` : remplace-le dans `.env` avant tout démarrage partagé ou déploiement. Changer les mots de passe du `.env` après la création initiale des comptes ne modifie pas leurs mots de passe déjà hachés en base.

L'Administrateur système se connecte au même écran que les autres acteurs et accède à son tableau de bord dédié. Les comptes peuvent être recherchés, filtrés, créés, modifiés, activés/désactivés et supprimés (avec contrôle d'historique et confirmation). Les événements de connexion et les opérations administratives sont journalisés. Une modification de compte crée une notification dans le compte concerné et envoie un e-mail lorsque SMTP est configuré. Le dernier administrateur actif ne peut pas être désactivé ou rétrogradé.

Le tableau de bord d'administration est une interface statique intégrée à FastAPI ; sa navigation ne recharge pas la page. L'interface de supervision des rôles Technicien, Responsable et Direction reste disponible séparément. Les données persistées conservent les modes d'acquisition existants : les mesures simulées servent aux essais sans matériel, tandis que le mode matériel utilise l'ESP32/MicroPython configuré dans Thonny et transmis par MQTT. Les nouvelles tables sont créées au démarrage et les colonnes de profil manquantes sont ajoutées sans supprimer les comptes existants.

## Guide de test Release 1

### T1 — US-48 Broker démarré et authentifié

```powershell
docker compose ps
docker compose logs --tail 50 mosquitto
```

Attendu : `mosquitto` est `running` et `healthy`, le broker écoute sur 1883 dans Docker, l’accès hôte est publié sur 1884, et le journal indique le démarrage sans erreur d’ACL ou de fichier de mot de passe. Il ne doit pas accepter de client anonyme.

### T2 — US-42 Authentification et rôles API

Ouvre `http://localhost:8001/docs`.

1. `GET /api/health` doit répondre `200`.
2. `GET /api/machines` sans jeton doit répondre `401`.
3. `POST /api/auth/login` avec un mot de passe erroné doit répondre `401`.
4. Connecte-toi via `POST /api/auth/login` avec un compte technicien ; copie `access_token`, clique sur **Authorize** et saisis le jeton. `GET /api/machines` doit répondre `200`.
5. Avec le jeton Direction, `POST /api/alerts/{id}/acknowledge` doit répondre `403`.
6. Une requête d’ingestion `POST /api/telemetry/{machine_id}` sans jeton doit répondre `401`; le rôle Responsable est requis.

### T3 — Mode simulé sans capteurs ni ESP32

Le simulateur Python publie les quatre grandeurs (température, humidité, vibrations et courant) au broker MQTT. Il lit `MQTT_USERNAME`, `MQTT_PASSWORD` et `MQTT_HOST_PORT` depuis le `.env` à la racine du dépôt. Un seul émetteur doit utiliser un `machine_id` à la fois : arrête le simulateur avec `Ctrl+C` avant de lancer le firmware pour la même machine.

Depuis PowerShell à la racine du dépôt, prépare l'environnement local une seule fois :

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
docker compose up -d --build
docker compose ps
```

Dans un terminal PowerShell séparé, démarre le scénario cyclique **normal → avertissement → critique → retour normal** :

```powershell
Push-Location backend
..\.venv\Scripts\python.exe -m app.simulation --machine-id demo-machine --scenario cycle --interval 5
Pop-Location
```

Pour ne publier que des mesures normales ou critiques, remplace `cycle` par `normal` ou `critical`. Arrête le simulateur avec `Ctrl+C`. Attendu : les lignes `Publié` affichent `acquisition_mode: simulated`; les mesures et les alertes sont enregistrées par le backend. Vérifie le résultat dans le tableau de bord ou avec la requête SQL du test suivant.

### T4 — US-18/49 ESP32 et acquisition matérielle

1. Lance `/main.py` dans Thonny avec un DHT22 et HW-072 raccordés sur GPIO27 et GPIO16.
2. Attendu : Wi-Fi connecté, compteur `seq` croissant, `acquisition_mode: hardware` et message JSON publié toutes les cinq secondes.
3. Température/humidité doivent évoluer selon la pièce. Tapote doucement le banc et vérifie que les événements HW-072 changent après réglage de son potentiomètre.
4. Le DHT22 et le HW-072 sont lus depuis les GPIO configurés. Tant que l’ACS712 et son câblage ne sont pas validés, garde `current_mode` à `simulated` : `current_source` vaut alors `simulated` et `current_rms` vaut `0.0`. Ne passe `current_mode` à `hardware` que lorsque l’entrée ADC et le diviseur de tension ont été vérifiés. `current_mode` ne concerne que le courant ; `acquisition_mode: hardware` indique le parcours ESP32.

Le HW-072 est une sortie numérique ; son taux dépend du réglage et n’est pas une mesure d’accélération étalonnée.

### T5 — US-19 Message stocké dans PostgreSQL

Après avoir vu plusieurs messages `Publié` dans Thonny, exécute :

```powershell
docker compose exec postgres psql -U predimaint -d predimaint -c "SELECT machine_id, seq, temperature, humidity, vibration_rate, current_rms, current_source, acquisition_mode, recorded_at FROM measurements ORDER BY recorded_at DESC LIMIT 10;"
```

Adapte `-U`/`-d` si tu as choisi d’autres valeurs dans `.env`. Attendu : nouvelles lignes, machine `demo-machine`, séquences provenant du firmware et dates serveur récentes.

### T6 — US-20 Alerte et retour sous seuil

La méthode la plus sûre est de simuler des lectures par l’API, sans chauffer la machine :

1. Dans l’interface, connecte-toi comme Responsable. Dans **Seuils d’alerte**, choisissez Température et réglez avertissement `60`, critique `75` (valeurs initiales).
2. Ouvre `http://localhost:8001/docs`, autorise-toi avec le jeton du Responsable, puis utilise `POST /api/telemetry/{machine_id}` pour `demo-machine` avec ce JSON :

   ```json
   {"seq": 9001, "temperature": 66, "humidity": 55, "vibration_rate": 0, "vibration_edges": 0, "current_rms": 0, "current_source": "simulated", "acquisition_mode": "simulated"}
   ```

   La réponse attendue est `202`; une alerte **warning** apparaît dans le tableau de bord.
3. Recommence avec `seq: 9002` et `temperature: 80`. L’alerte active existante doit passer à **critical**, sans créer une nouvelle alerte par mesure.
4. Recommence avec `seq: 9003` et `temperature: 50`. L’alerte doit se clôturer automatiquement; elle reste visible dans l’historique des alertes.
5. Si tu as modifié les seuils pour ce test, remets les valeurs adaptées à ton banc avant de connecter une machine réelle.

### T7 — US-23 Déclarer une machine et ses capteurs

Connecte-toi comme Responsable et va à **Machines et capteurs**.

1. Crée la machine `pompe-test` avec nom et description ; elle doit apparaître dans le parc et démarrer hors ligne.
2. Déclare un capteur Température / type `DHT22` / GPIO `27` / unité `°C`; il doit apparaître dans la liste.
3. Désactive puis réactive le capteur.
4. Archive puis réactive la machine. L’historique n’est pas supprimé.
5. Connecte-toi comme Technicien : la zone d’administration n’est pas visible et la création d’une machine via l’API doit répondre `403`.

### T8 — US-41 ACL MQTT appareil/backend

1. Avec l’ESP32 et le compte appareil, publie sur `predimaint/demo-machine/telemetry`; le backend doit enregistrer la mesure.
2. Vérifie le journal broker : l’abonné backend est connecté avec le compte `predimaint_backend`; le firmware utilise le compte appareil.
3. Lance `powershell -ExecutionPolicy Bypass -File scripts/verify-mqtt-acl.ps1`. La publication par `demo-machine` doit réussir et la publication croisée par `autre-machine` doit être refusée.
4. Un client sans identifiant/mot de passe doit être refusé. Le compte appareil ne dispose que des droits de publication configurés par ACL ; le backend a un identifiant distinct.

Les échanges MQTT de ce profil local sont authentifiés et filtrés par ACL mais ne sont pas chiffrés par TLS. Reste sur un réseau local de confiance ; ne publie pas le broker sur Internet.

### T9 — US-47 Git et préparation Trello

Dans le dépôt local :

```powershell
git status --short
git check-ignore .env .env.trash firmware/config.json mosquitto/passwd
```

Attendu : les fichiers de configuration locale et le fichier de mots de passe Mosquitto sont ignorés. Les changements code/docs sont suivis. Le dépôt local est initialisé; avant le premier commit, vérifie `git status`, puis fais `git add .` et `git commit -m "Release 1 PrediMaint"`. Avant un dépôt distant, configure le remote de l’équipe et n’ajoute jamais `.env`, `mosquitto/passwd`, clés, mots de passe ou captures contenant des secrets.

Le board à créer dans Trello est préparé dans [`docs/releases/release-1/trello-board.md`](docs/releases/release-1/trello-board.md) avec les 9 cartes, leurs critères d’acceptation et les listes proposées. Crée un board `PrediMaint — Release 1`, puis reporte les cartes dans Trello et relie le dépôt Git. Aucun board externe n’est créé automatiquement par le code local.

### T10 — Tests automatisés de régression

Avec Docker démarré :

```powershell
docker compose run --build --rm backend pytest -q
```

Attendu : tests verts sur règles de seuil, authentification, permissions, persistance, migration des données existantes, génération simulée de mesures normales/avertissement/critiques, machines/capteurs et transitions d’alerte. Les tests remplacent PostgreSQL et MQTT par une base SQLite en mémoire et ne publient pas de données sur le broker réel.

## Parcours Technicien — exécuter et retester

### Démarrer le socle commun

Depuis PowerShell, à la racine du dépôt :

```powershell
docker compose up -d --build
docker compose ps
```

Vérifiez que `backend`, `postgres` et `mosquitto` sont démarrés et que PostgreSQL et le broker sont `healthy`. Ouvrez ensuite `http://localhost:8001`.

### Mode simulé — sans ESP32

Le simulateur doit utiliser les dépendances de `.venv` (et non celles d'Anaconda). Installez-les dans cet environnement depuis la racine du dépôt :

```powershell
if (-not (Test-Path .venv\Scripts\python.exe)) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Dans un second terminal, démarrez les mesures simulées via MQTT :

```powershell
Push-Location backend
..\.venv\Scripts\python.exe -m app.simulation --machine-id demo-machine --scenario cycle --interval 5
Pop-Location
```

Le cycle publie des mesures normales, d'avertissement, critiques puis un retour sous les seuils. Les quatre grandeurs sont envoyées : température, humidité, vibrations et courant simulé. Pour un scénario fixe, remplacez `cycle` par `normal` ou `critical`. Arrêtez le processus avec `Ctrl+C` avant de passer au mode matériel pour la même machine.

Vérifiez dans l'espace Technicien que les mesures affichent le mode **Simulé**, que les alertes suivent le cycle, qu'un événement critique apparaît dans l'historique et qu'une notification est créée pour les Techniciens autorisés sur cette machine.

### Mode matériel — ESP32, MicroPython et Thonny

1. Laissez Docker actif et arrêtez le simulateur. Dans Thonny, sélectionnez l'interpréteur MicroPython ESP32 et le port USB de votre carte.
2. Copiez `firmware/config.example.json` vers `/config.json` sur l'ESP32. Renseignez le Wi-Fi, l'adresse IP du PC sur le réseau, le port MQTT publié par Docker (1884 par défaut), les identifiants MQTT de l'équipement et l'identifiant de machine.
3. Enregistrez `firmware/main.py` sur l'ESP32 sous `/main.py`, puis lancez-le. Vérifiez la connexion Wi-Fi, le compteur de séquence croissant et les publications MQTT.
4. Le firmware publie `acquisition_mode: hardware`. Le courant reste `current_source: simulated` tant que l'ACS712 et son câblage ne sont pas validés. N'activez sa lecture matérielle qu'après vérification électrique, du diviseur de tension et du calibrage.

Les modes simulé et matériel partagent le même broker, les mêmes API et les mêmes pages. Le mode d'acquisition est indiqué dans les mesures ; il n'est pas nécessaire de changer de base de données entre les deux.

### Vérifications fonctionnelles manuelles

1. **Affectation :** connectez-vous comme Responsable de maintenance, attribuez une intervention à un compte Technicien et sélectionnez une machine. L'affectation autorise ce Technicien à consulter cette machine.
2. **Accès limité :** connectez-vous comme Technicien. Vérifiez qu'il ne voit que ses machines et interventions. Un autre Technicien non autorisé ne doit pas voir les mesures ou alertes de cette machine.
3. **Alertes :** générez le scénario `critical`, prenez en charge une alerte puis vérifiez que son état, l'heure et le compte responsable sont conservés. Une mesure sous le seuil clôture l'alerte.
4. **Interventions :** faites passer une intervention attribuée à « En cours », renseignez le diagnostic, le travail effectué et le résultat. Rechargez la page : le suivi doit être conservé. Une modification concurrente doit être signalée plutôt qu'écrasée.
5. **Mesures et pannes :** choisissez une machine, un capteur et une période. Vérifiez les unités, les horodatages, les valeurs min/max/moyenne et les filtres de l'historique critique.
6. **Notifications :** vérifiez les alertes et affectations reçues, puis marquez une notification comme lue.
7. **Calibration :** enregistrez une référence, une mesure et une observation ; vérifiez l'historique. Cette action consigne un relevé et ne modifie pas le firmware.
8. **Hors ligne :** ouvrez d'abord l'application en ligne pour mettre en cache son interface et les données autorisées. Dans les outils développeur du navigateur, activez ensuite l'état hors ligne. Vérifiez l'indicateur, puis enregistrez un compte rendu local : il doit rester explicitement « en attente du serveur ». Rétablissez le réseau et synchronisez. En cas de conflit, actualisez l'intervention et résolvez-le avant une nouvelle synchronisation.
9. **Profil et récupération :** modifiez vos coordonnées, puis testez le changement de mot de passe depuis le profil. Pour le lien « Mot de passe oublié ? », configurez SMTP et `PUBLIC_BASE_URL` avec une adresse joignable ; le lien expire après 15 minutes et ne peut être utilisé qu'une fois.
10. **Responsive :** répétez la navigation sur un écran étroit et vérifiez l'ouverture du menu latéral, les formulaires et les tableaux défilants.

Après les tests manuels, relancez les tests automatisés :

```powershell
docker compose run --build --rm backend pytest -q
```

Si `.venv` affiche `ModuleNotFoundError: No module named 'paho'`, réinstallez les dépendances dans **le même interpréteur** que celui qui lance le simulateur :

```powershell
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

## Contrat MQTT

Topic mesure : `predimaint/{machine_id}/telemetry`; état retained : `predimaint/{machine_id}/status` (`online`/`offline`). Exemple :

```json
{
  "seq": 25,
  "temperature": 24.1,
  "humidity": 58.2,
  "vibration_rate": 0.0,
  "vibration_edges": 0,
  "current_rms": 0.0,
  "current_source": "simulated",
  "acquisition_mode": "hardware"
}
```

Le firmware publie QoS 1. Le backend valide les plages, refuse une machine non déclarée ou archivée, écrit la mesure et évalue les seuils activés.

## Limites connues à la fin du Release 1

- Le courant est simulé jusqu’à validation électrique, calibration de l’ACS712 et test avec une charge basse tension protégée.
- Le HW-072 ne donne pas de vitesse/accélération calibrée ; la mesure est un nombre d’événements numériques avec filtrage anti-rebond.
- Les règles sont des seuils simples, sans analyse prédictive statistique/ML ni hystérésis configurable.
- MQTT local utilise un mot de passe et des ACL mais pas TLS ; une configuration TLS adaptée au nom/IP du réseau est requise avant tout réseau non fiable.
- Gestion des comptes (création, désactivation, réinitialisation mot de passe) et board Trello distant non automatisés dans ce release.
- Schéma PostgreSQL créé au démarrage ; une migration additive est appliquée à la table machines pour la base persistante existante.

