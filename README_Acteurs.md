# PrediMaint — guide fonctionnel et technique des acteurs

Ce document décrit les fonctionnalités effectivement présentes dans le dépôt pour
l’**Administrateur système**, le **Technicien de maintenance**, le
**Responsable de maintenance** et le **Directeur de production**, ainsi que leurs
principaux composants, API, données, permissions et méthodes de validation. Les
indicateurs nécessitant des données industrielles encore absentes sont signalés
comme indisponibles; ils ne sont pas présentés comme des résultats de production.

Il complète [README.md](README.md) et le guide de lancement/test
[README_RELEASE_1.md](README_RELEASE_1.md). Les règles de sécurité sont appliquées
côté API : masquer un bouton dans l’interface ne constitue jamais une permission.

## 1. Socle technique commun

### Technologies et architecture

| Couche | Technologies / emplacement |
|---|---|
| Interface | HTML, CSS et JavaScript statiques servis par FastAPI, sans framework SPA |
| API | FastAPI, Pydantic et SQLAlchemy |
| Base de données | PostgreSQL dans Docker Compose ; SQLite en mémoire pour les tests API |
| Acquisition IoT | Mosquitto MQTT, simulateur Python et firmware ESP32/MicroPython |
| Authentification | Jetons JWT Bearer, rôles vérifiés pour chaque requête |
| Fichiers principaux | `backend/app/static/`, `backend/app/api/`, `backend/app/infrastructure/` |

Les services communiquent suivant ce parcours :

```text
Simulateur Python ou ESP32/MicroPython
                │ MQTT : predimaint/{machine_id}/telemetry
                ▼
             Mosquitto ──► MqttIngestor ──► SQLAlchemy ──► PostgreSQL
                                                             │
Navigateur ── HTTP /api + JWT ──► FastAPI ───────────────────┘
```

Le navigateur reçoit `index.html`, `styles.css` et les modules JavaScript sous
`backend/app/static/`. `app.js` authentifie l’utilisateur et distribue l’interface
selon son rôle. `admin.js` et `technician.js` gèrent respectivement les espaces
administrateur et technicien.

### Identité visuelle commune

Les espaces reprennent les mêmes variables de couleur dans `styles.css` :

| Usage | Couleur |
|---|---|
| Fond principal | `#FAF5EC` |
| Surfaces | `#EADFC8` |
| Accent | `#D4A373` |
| Actions | `#287271` |
| Navigation et titres foncés | `#1D3B3A` |

La navigation latérale est fixe sur grand écran et devient un menu ouvrable sur
petit écran. La navigation de page s’effectue côté navigateur, sans recharger
l’application à chaque changement de section.

### Comptes, connexion et contrôle d’accès

Les rôles existants sont `admin`, `technician`, `manager` et `director`. Après
connexion, l’API `/api/auth/login` fournit un JWT ; `/api/auth/me` restitue l’identité
du compte. Le navigateur stocke le jeton et le rôle dans `localStorage`, puis
`app.js` ouvre l’espace correspondant.

Le rôle `director` ouvre désormais un espace de consultation dédié. Son périmètre,
ses limites de données et ses routes sont décrits à la section 5.

Pour chaque requête protégée, `current_user` valide la signature, l’expiration, le
rôle et la version du jeton avec le compte en base. Les comptes désactivés ne peuvent
pas utiliser l’API. Une modification de rôle/statut par l’administrateur ou un
changement de mot de passe incrémente `token_version` et invalide les sessions
précédentes.

Les mots de passe sont hachés avec `pwdlib` (configuration recommandée Argon2).
Les valeurs initiales et secrets viennent de `.env` et `.env.example` ; les
identifiants réels ne doivent jamais être copiés dans la documentation ou Git.

### API communes de compte

Ces routes sont définies dans `backend/app/api/routes.py` et préfixées par `/api` :

| Méthode et route | Utilité |
|---|---|
| `POST /api/auth/login` | Authentifier un compte actif |
| `GET /api/auth/me` | Lire le compte authentifié |
| `POST /api/auth/password-reset/request` | Demander un lien de récupération |
| `POST /api/auth/password-reset/complete` | Valider le lien et définir un nouveau mot de passe |
| `GET /api/profile` | Lire le profil du compte courant |
| `PATCH /api/profile` | Modifier nom, courriel et téléphone |
| `POST /api/profile/password` | Vérifier le mot de passe actuel et en définir un nouveau |

#### Mot de passe oublié

La page de connexion propose « Mot de passe oublié ? ». L’API répond de manière
générique, que l’adresse existe ou non, afin de ne pas révéler la présence d’un
compte. Pour un compte actif, le mécanisme :

1. crée un jeton aléatoire valable 15 minutes et à usage unique ;
2. ne conserve en base que son empreinte, pas le jeton brut ;
3. limite les demandes à trois par adresse et par IP sur une fenêtre de 15 minutes ;
4. envoie le lien par SMTP, dans le fragment URL `#reset_token=...` ;
5. après validation du nouveau mot de passe, révoque les sessions antérieures.

Le formulaire impose au minimum 12 caractères et la confirmation du nouveau mot de
passe. Le lien nécessite une configuration SMTP valide et `PUBLIC_BASE_URL`
joignable depuis l’appareil qui reçoit le courriel. Une notification intégrée à
l’application ne remplace pas l’envoi du lien de récupération.

Pour Brevo, renseignez dans `.env` le serveur `smtp-relay.brevo.com`, le port `587`,
l’identifiant SMTP affiché par Brevo, la **clé SMTP** (pas une clé API) et une
adresse expéditrice vérifiée. Après modification de `.env`, recréez le backend :

```powershell
docker compose up -d --force-recreate backend
```

> Les courriels de modification de compte peuvent indiquer qu’un message a échoué.
> Dans ce cas, l’état et le motif sont consultables dans les notifications/journaux
> administrateur. Sans SMTP, les notifications de compte restent disponibles dans
> l’application ; la récupération par lien envoyé ne peut pas fonctionner.

---

## 2. Acteur 1 — Administrateur système

### Responsabilité et périmètre

L’administrateur système gère les comptes et les rôles, consulte les journaux
d’accès et d’activité, traite les notifications et gère son propre profil et ses
préférences. Il peut aussi enregistrer le remplacement traçable d’un capteur
défectueux. La gestion courante du parc et des interventions reste au Responsable
de maintenance.

Le préfixe de toutes les routes d’administration est `/api/admin`. Les handlers de
`backend/app/api/admin.py` appliquent `require_roles("admin")` ; les pages du menu ne
sont donc pas accessibles aux autres rôles par simple appel HTTP.

### Pages disponibles

| Page | Fonction |
|---|---|
| Vue d’ensemble | Totaux utilisateurs, comptes actifs/inactifs, répartitions par rôle, connexions du jour, activité et notifications récentes |
| Gestion des utilisateurs | Recherche par nom/courriel, filtres par rôle/statut, liste et actions de compte |
| Ajouter un utilisateur | Créer un compte et choisir son rôle, ses coordonnées, son statut et son mot de passe initial |
| Rôles et permissions | Présenter les rôles définis par l’application et le nombre de comptes correspondants |
| Historique des connexions | Examiner les événements, adresses IP, dates et résultats succès/échec |
| Journal d’activité | Examiner les opérations administratives et leurs cibles |
| Notifications | Voir les notifications de compte, l’état d’envoi et les alertes système récentes |
| Sauvegardes PostgreSQL | Créer et télécharger des sauvegardes, consulter l’historique et configurer l’automatisation |
| Remplacement de capteur | Choisir une machine et un capteur actif, saisir le nouveau capteur et le motif, consulter l’historique |
| Mon profil | Mettre à jour ses coordonnées et modifier son mot de passe |
| Paramètres | Enregistrer les préférences disponibles : notifications par courriel, langue et durée de session |

La gestion des utilisateurs comprend :

- création avec nom, courriel, téléphone, rôle, statut et mot de passe temporaire ;
- recherche et filtrage ;
- modification des coordonnées, du rôle et de l’activation ;
- activation et désactivation ;
- suppression avec confirmation dans l’interface et contrôles côté serveur ;
- notification intégrée lors des opérations de compte et tentative d’envoi par
  courriel quand les notifications SMTP sont activées.

À la création, l’administrateur choisit le mot de passe initial et doit le
communiquer par un canal adapté. Le courriel de création informe l’utilisateur que
son compte existe ; il ne constitue pas un mécanisme d’invitation ni de livraison
automatique du mot de passe.

### Règles de sécurité et limites de suppression

- L’administrateur ne peut pas supprimer son propre compte.
- Le dernier administrateur actif ne peut pas être désactivé ni rétrogradé.
- La suppression d’un utilisateur ayant un historique d’interventions est refusée ;
  désactivez le compte pour préserver cet historique.
- La désactivation et le changement de rôle révoquent ses jetons existants.
- Les données de formulaire sont validées par Pydantic ; les champs inconnus sont
  refusés sur les modèles concernés.
- Les opérations administratives importantes sont consignées dans le journal
  d’activité.
- Lorsqu’un compte est modifié, l’utilisateur ciblé reçoit un message intégré et
  un courriel si SMTP et le paramètre de notification le permettent. Si son adresse
  a été modifiée, le message est adressé à l’adresse précédente pour signaler le
  changement.

**Courriel / WhatsApp :** la livraison implémentée ici est le courriel SMTP et la
notification intégrée à l’application. Aucun envoi WhatsApp n’est implémenté.

### Routes administrateur

Les routes sont relatives au préfixe `/api/admin` :

| Méthode et route | Description |
|---|---|
| `GET /overview` | Indicateurs et éléments récents du tableau de bord |
| `GET /users` | Liste avec paramètres `search`, `role` et `active` |
| `POST /users` | Créer un compte |
| `PATCH /users/{user_id}` | Modifier profil, rôle ou statut |
| `DELETE /users/{user_id}` | Supprimer si les règles de conservation le permettent |
| `GET /roles` | Définitions des rôles et effectifs |
| `GET /login-history` | Historique des connexions, filtrable par courriel |
| `GET /activity` | Journal des activités administratives |
| `GET /notifications` | Notifications de comptes et alertes système |
| `GET /sensors` | Capteurs et machines pour le formulaire de remplacement |
| `POST /machines/{machine_id}/sensors/{sensor_id}/replace` | Désactiver l’ancien capteur, créer le nouveau et journaliser l’opération |
| `GET /sensor-replacements` | Historique des remplacements avec motif, date et administrateur |
| `GET /backups` | Historique récent, dernier statut et prochaine exécution |
| `POST /backups` | Créer et vérifier un dump PostgreSQL manuel |
| `GET /backups/{backup_id}/download` | Télécharger une sauvegarde réussie |
| `GET /backups/config`, `PUT /backups/config` | Lire et configurer la sauvegarde automatique |
| `GET /profile`, `PATCH /profile` | Lire et modifier le profil administrateur |
| `POST /profile/password` | Changer son mot de passe |
| `GET /settings`, `PUT /settings` | Lire et enregistrer les préférences |
| `GET /notifications/me` | Notifications de compte pour l’utilisateur courant |

Les préférences `email_notifications`, `language` et `session_minutes` sont
enregistrées dans `system_settings`. La durée de session choisie est utilisée à
l’émission des prochains JWT ; les jetons déjà émis gardent leur expiration
existante. Les contrôles système ne remplacent pas la configuration du serveur
(SMTP, JWT, base de données).

La sauvegarde automatique est activée par défaut à 1 440 minutes (24 heures).
L’intervalle configurable est compris entre 1 et 525 600 minutes. Les dumps au
format custom sont créés par `pg_dump`, vérifiés par `pg_restore --list` et stockés
dans le volume Docker indépendant `predimaint_backups`. Les métadonnées et la
fréquence sont persistées en base. Les routes de sauvegarde sont réservées au rôle
`admin`; les secrets PostgreSQL ne sont jamais transmis au navigateur.
Les anciennes sauvegardes ne sont pas supprimées automatiquement; surveillez
l’espace disponible et appliquez une politique d’archivage conforme à vos règles
de conservation. Les archives contiennent des données sensibles.

### US-37 — Remplacement d’un capteur

Le remplacement est réservé au rôle `admin` et ne supprime pas l’ancien capteur.
L’opération désactive l’ancien capteur et crée un nouveau capteur actif sur la
même machine et pour la même grandeur, dans une transaction. Une contrainte unique
ne permet qu’un capteur actif par grandeur et machine; plusieurs anciens capteurs
désactivés sont conservés. Le motif, l’horodatage serveur, l’administrateur et les
identifiants des deux capteurs sont consultables dans l’historique.

Les nouvelles mesures physiques sont reliées au capteur actif par grandeur dans
`measurement_sensor_sources` et l’API de télémétrie expose cette information sous
`sensor_ids`. Les mesures stockées avant cette traçabilité restent intactes mais
sans attribution de capteur : leur source historique ne peut pas être déduite des
seules lignes de mesures. Les mesures simulées ne sont pas associées à des
capteurs physiques.

### Données et code concernés

| Besoin | Composants |
|---|---|
| Pages, filtres, formulaires, confirmations et affichage des erreurs | `backend/app/static/admin.js` |
| Structure HTML des deux espaces et des formulaires d’authentification | `backend/app/static/index.html` |
| Palette, navigation, tableaux et comportement responsive | `backend/app/static/styles.css` |
| Routage après authentification et flux de réinitialisation commun | `backend/app/static/app.js` |
| Modèles utilisateurs, journaux, paramètres et notifications | `backend/app/infrastructure/models.py` |
| Gestion API administrateur et règles de validation | `backend/app/api/admin.py` |
| Authentification, JWT et autorisation par rôle | `backend/app/api/auth.py` |
| Envoi SMTP | `backend/app/infrastructure/notifications.py` |
| Création `pg_dump`, planification et vérification `pg_restore` | `backend/app/infrastructure/database_backups.py` |
| Métadonnées de sauvegarde | `DatabaseBackupRow` dans `backend/app/infrastructure/models.py` |
| Fichiers persistants, séparés de PostgreSQL | Volume Docker `predimaint_backups`, monté dans le backend à `/var/lib/predimaint/backups` |
| Remplacement de capteur et historique | `SensorReplacementRow`, routes `backend/app/api/admin.py` et formulaire `backend/app/static/admin.js` |
| Provenance des mesures physiques | `MeasurementSensorSourceRow` et `backend/app/infrastructure/repository.py` |

---

## 3. Acteur 2 — Technicien de maintenance

### Responsabilité et périmètre

Le Technicien consulte les machines et données qui lui sont autorisées, prend en
charge les alertes qui lui sont accessibles, met à jour ses interventions, renseigne
les diagnostics et consigne les calibrations. Il ne gère pas les comptes, les rôles,
les seuils généraux, ni la configuration des machines et capteurs.

Après connexion, le rôle `technician` est dirigé vers `#tech-overview`. L’espace
dispose d’une barre latérale dédiée et d’une navigation sans rechargement. Tous les
comptes de rôle Technicien utilisent le même parcours et les mêmes contrôles côté
serveur.

### Pages et fonctionnalités

| Page | Fonctionnalités |
|---|---|
| Vue d’ensemble | Nombre de machines autorisées/en ligne, alertes actives, interventions à suivre et dernière mesure reçue |
| Mes alertes | Consulter les alertes des machines accessibles, filtrer et prendre en charge une nouvelle alerte |
| Mes interventions | Historique complet des statuts attribué/accepté/en cours/terminé/annulé, filtre par état, compte rendu détaillé et photos |
| Mes machines | Consulter les machines autorisées, leur fiche détaillée, leurs capteurs, dernières mesures, alertes et besoin d’intervention |
| Mesures des capteurs | Choisir machine, grandeur et période ; consulter minimum, maximum, moyenne, valeurs au-dessus du seuil, graphique et tableau |
| Historique des pannes | Consulter les événements critiques, filtrer et enregistrer diagnostic, intervention et résultat |
| Notifications | Lire et marquer les notifications comme lues; activer les notifications navigateur si le serveur est configuré en Web Push |
| Mode hors ligne | Préparer localement des comptes rendus autorisés et les synchroniser ultérieurement |
| Calibration | Enregistrer machine, capteur, valeur de référence, valeur mesurée et observations |
| Mon profil | Modifier ses coordonnées et son mot de passe |

Les textes d’aide s’adressent à l’utilisateur avec « vous ». Un compte sans machine
autorisée voit un message lui demandant de contacter son Responsable ; l’application
ne lui ouvre pas l’accès aux machines automatiquement.

### Affectations et autorisations de machines

Les autorisations sont stockées dans `machine_technician_access`. Le Technicien ne
voit que les machines actives autorisées pour son identifiant :

- le Responsable peut créer une intervention attribuée à un Technicien ; cette
  opération accorde également l’accès de ce Technicien à la machine de l’intervention ;
- le Responsable peut aussi accorder ou révoquer explicitement l’accès à une machine ;
- les nouveaux comptes Technicien ne reçoivent pas l’accès à toutes les machines
  par défaut ;
- la visibilité des mesures, alertes, capteurs, événements critiques, calibrations
  et interventions est filtrée côté API selon ces autorisations ;
- un accès refusé ou une machine non autorisée n’est pas rendu visible en contournant
  l’interface.

Pour qu’un nouveau Technicien voie les mesures du simulateur, le Responsable doit
lui attribuer une intervention sur la machine correspondante ou autoriser cette
machine depuis l’API de gestion des accès.

### Suivi d’intervention

Les interventions sont liées à une machine et à un Technicien affecté. Les états
gérés comprennent `assigned`, `accepted`, `in_progress`, `completed` et `cancelled`.
Le Technicien peut renseigner l’état et les champs de suivi qui lui sont permis ;
il ne peut pas réattribuer l’intervention ni en modifier les données de gestion.
Une mission apparaît dans « Mes interventions » après son attribution par le
Responsable. Le formulaire de diagnostic dans « Historique des pannes » met à jour
l’événement critique et ne crée pas de mission planifiée. De même, « Prendre en
charge » sur une alerte enregistre son état et sa date, sans créer automatiquement
une intervention.

La mise à jour utilise une révision serveur (`revision` / `expected_revision`) pour
empêcher l’écrasement silencieux d’une modification concurrente. Le client hors ligne
associe une opération à un `client_action_id` afin que sa répétition ne duplique pas
l’action. Le serveur refuse les transitions de statut non permises ; le travail
effectué est requis pour terminer une intervention.

La liste du Technicien n’applique pas le plafond de 300 éléments utilisé pour les
autres rôles : tous ses enregistrements autorisés restent consultables après une
reconnexion. Le filtre d’état ne supprime ni n’archive les autres interventions.
Les comptes rendus terminés affichent le diagnostic, le travail réalisé, le
résultat et la date de clôture.

### Fiche machine et photos d’intervention

Dans « Mes machines », ouvrez **Ouvrir la fiche détaillée** pour afficher les
dernières valeurs réellement stockées, les capteurs déclarés (actifs et inactifs),
les alertes/anomalies en cours et le nombre d’interventions actives qui vous sont
attribuées. Le backend revérifie l’accès à la machine pour chaque requête.

Dans une intervention, ouvrez **Photos de l’intervention** pour joindre ou
consulter des images JPEG, PNG ou WebP (8 Mio maximum par fichier). Le type est
déduit du contenu du fichier, le nom de stockage est généré par le serveur et les
routes de liste/téléchargement vérifient l’accès à l’intervention. Les fichiers
sont dans le volume Docker indépendant `predimaint_intervention_photos`, distinct
de `postgres_data` et `predimaint_backups`; cette configuration conserve les
fichiers lors d’un redémarrage normal des conteneurs, à vérifier dans
l’environnement déployé. Il n’existe pas de suppression de photo depuis
l’interface. Le `pg_dump` de la base ne contient pas les octets des photos : le
volume de photos doit être sauvegardé séparément si cette exigence s’applique.

### Web Push et délais d’alerte

Les notifications internes persistent et restent visibles sans configuration
Web Push. Pour recevoir une notification système lorsque l’application est en
arrière-plan, configurez `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY` (PEM encodé en Base64 avec préfixe `base64:`) et
`WEB_PUSH_VAPID_SUBJECT` dans le `.env` local, puis recréez le backend. La clé
privée reste côté serveur; l’API remet au navigateur uniquement la clé publique.
L’inscription est réservée au compte Technicien courant et limitée aux hôtes
publics des services Push courants (Google FCM, Mozilla, Windows et Apple). Le
navigateur doit prendre en charge Push et autoriser les notifications; `localhost`
est un contexte sécurisé de développement, tandis qu’un déploiement public doit
utiliser HTTPS. Sans clés valides et sans test dans un navigateur réel, ne
considérez pas la livraison Web Push comme vérifiée.

Générez une paire localement avec l’environnement Python du projet, copiez les
deux valeurs dans le `.env` non versionné et remplacez l’adresse de contact :

```powershell
& .\.venv\Scripts\python.exe -c "import base64; from py_vapid import Vapid; from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat; v=Vapid(); v.generate_keys(); public=base64.urlsafe_b64encode(v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)).rstrip(b'='); print('WEB_PUSH_VAPID_PUBLIC_KEY='+public.decode()); print('WEB_PUSH_VAPID_PRIVATE_KEY=base64:'+base64.b64encode(v.private_pem()).decode())"
```

Après avoir mis les trois variables `WEB_PUSH_VAPID_*` dans `.env`, reconstruisez
uniquement le backend, sans supprimer les volumes :

```powershell
docker compose up -d --build --force-recreate backend
```

Les délais sont horodatés sans inventer d’heure d’acquisition : le firmware
MicroPython actuel n’envoie pas d’horodatage de lecture. `received_at` indique
l’arrivée au backend, `processing_delay_ms` mesure le traitement backend jusqu’à
la création de l’événement d’alerte, `push_sent_at` indique l’acceptation par le
service Push et `received_at` des notifications est renseigné quand l’application
Technicien confirme leur réception. Les événements historiques antérieurs à ces
colonnes gardent des mesures nulles, jamais reconstituées. Aucun SLA maximal
n’est défini; une cible de **30 secondes entre détection et réception par
l’application** peut être proposée pour validation, mais n’est pas appliquée comme
un seuil automatique.

### Mode hors ligne et synchronisation

`technician.js` met en cache dans `localStorage` les réponses GET de l’utilisateur
courant, séparées par son identifiant. Le service worker met en cache le shell
statique de l’application ; il ne met pas en cache les routes `/api`.

En absence de réseau :

1. seules les données précédemment obtenues et autorisées peuvent être consultées ;
2. un compte rendu hors ligne ne peut être préparé que pour une intervention ouverte
   déjà attribuée au Technicien ; sans mission attribuée, le formulaire n’est pas
   proposé et l’interface indique de contacter le Responsable ;
3. un compte rendu hors ligne est un brouillon local, conservé avec une clé d’action,
   une révision attendue et l’identifiant de l’intervention ;
4. l’interface indique explicitement que le brouillon n’est pas encore enregistré
   sur le serveur ;
5. lorsque le réseau revient, le Technicien peut synchroniser ;
6. en cas de révision obsolète, le conflit est affiché et doit être examiné avant
   de préparer une nouvelle synchronisation.

Les brouillons sont locaux au navigateur/appareil : ne videz pas les données du site
avant leur synchronisation. Une déconnexion efface les données de cache associées
au compte ; les brouillons en attente sont traités à part dans le flux de
déconnexion de l’application.

### Calibration et événements critiques

Une calibration conserve les valeurs de référence et mesurées ainsi que les
observations du Technicien. Elle documente un contrôle ; elle ne met pas à jour le
firmware et ne change ni les seuils ni la configuration électrique.

Un dépassement de seuil produit un événement à diagnostiquer ; il ne prouve pas à
lui seul une panne matérielle. L’historique permet d’ajouter un diagnostic, une
intervention réalisée et un résultat.

### API Technicien

Toutes les routes ci-dessous sont définies dans `backend/app/api/routes.py` sous le
préfixe `/api`. Les routes de lecture filtrent les données par utilisateur et par
machine autorisée.

| Méthode et route | Fonction |
|---|---|
| `GET /technician/overview` | Indicateurs du tableau Technicien |
| `GET /machines` | Machines visibles pour le compte |
| `GET /machines/{machine_id}/details` | Fiche et données récentes d’une machine autorisée |
| `GET /machines/{machine_id}/telemetry` | Mesures filtrées par date/période |
| `GET /machines/{machine_id}/sensors` | Capteurs d’une machine autorisée |
| `GET /alerts` | Alertes visibles |
| `POST /alerts/{alert_id}/acknowledge` | Prendre en charge une alerte |
| `GET /alerts/{alert_id}/history` | Historique d’une alerte |
| `GET /interventions` | Interventions accessibles au compte |
| `PATCH /interventions/{intervention_id}` | Mettre à jour le suivi selon le rôle |
| `GET /interventions/{intervention_id}/photos` | Lister les photos d’une intervention accessible |
| `POST /interventions/{intervention_id}/photos` | Joindre une photo à une intervention accessible |
| `GET /interventions/{intervention_id}/photos/{photo_id}` | Afficher une photo après vérification de l’accès |
| `GET /failures`, `PATCH /failures/{failure_id}` | Lire et diagnostiquer les événements critiques |
| `GET /calibrations`, `POST /calibrations` | Lire et consigner les calibrations |
| `GET /notifications` | Notifications du Technicien |
| `GET /notifications/push/vapid-key` | État Push et clé publique uniquement |
| `POST /notifications/push/subscriptions` | Enregistrer l’abonnement Push du Technicien courant |
| `DELETE /notifications/push/subscriptions` | Retirer cet abonnement Push |
| `POST /notifications/received` | Horodater l’accusé de réception par l’application |
| `POST /notifications/{notification_id}/read` | Marquer une notification comme lue |
| `GET /profile`, `PATCH /profile` | Lire et modifier ses coordonnées |
| `POST /profile/password` | Changer son mot de passe |

Le Responsable dispose en outre des opérations de gestion et d’affectation des
interventions, des routes `/machines/{machine_id}/technicians/{technician_id}` pour
autoriser/révoquer une machine, ainsi que des routes de configuration machine,
capteur et seuil. Le Technicien n’a pas accès à ces opérations de gestion.

### Données et code concernés

| Besoin | Composants |
|---|---|
| Navigation Responsable, pages du parc, interventions, profil et routage des rôles | `backend/app/static/app.js` |
| Navigation et pages Technicien, graphiques, cache, brouillons et synchronisation | `backend/app/static/technician.js` |
| Formulaire de profil partagé Responsable / Technicien | `backend/app/static/profile.js` |
| Entrées de navigation, espace Technicien et formulaires communs | `backend/app/static/index.html` |
| Responsive, palette et styles Technicien | `backend/app/static/styles.css` |
| Routage de rôle, connexion, notification et réinitialisation mot de passe | `backend/app/static/app.js` |
| Endpoints, validations et autorisations par machine/intervention | `backend/app/api/routes.py` |
| Affectations, mesures, alertes, événements et notifications | `backend/app/infrastructure/models.py` |
| Ingestion MQTT, alertes et génération d’événements/notifications | `backend/app/infrastructure/mqtt_client.py`, `backend/app/infrastructure/repository.py` |
| Mise en cache du shell hors ligne | `backend/app/static/service-worker.js` |
| Photos d’intervention et abonnements Push | `backend/app/infrastructure/models.py`, `backend/app/infrastructure/web_push.py` |

---

## 4. Acteur 3 — Responsable de maintenance

Le compte `manager` utilise une interface dédiée avec une barre latérale et une
navigation sans rechargement. Les pages comprennent la vue d’ensemble, les alertes,
les interventions, le parc et les capteurs, la comparaison de machines, les seuils,
la performance et le profil. Les opérations sensibles sont également limitées par
rôle côté API.

### Performance, transitions et conventions

`GET /api/manager/performance?period=24h|7d|30d` calcule les indicateurs à partir
des transitions d’état persistées et des pannes déclarées par un Responsable. Le
tableau de bord est actualisé quand la page est visible, au rythme du rafraîchissement
du dashboard (5 secondes).

La disponibilité présentée est la **disponibilité de supervision MQTT**, et non
une disponibilité mécanique : `temps en ligne / temps observé × 100`. Une période
est observée seulement après le premier état connu; les périodes inconnues sont
exclues du numérateur et du dénominateur, et la couverture (temps observé / temps
depuis la création des machines) les rend visibles. Les indicateurs de
disponibilité sont qualifiés de suffisants uniquement à partir de 95 % de couverture.
Les événements antérieurs à l’ajout de l’historique ne sont pas reconstruits.

Les messages MQTT `online`/`offline` (y compris le Last Will du firmware) et les
mesures qui font passer une machine en ligne ajoutent un événement uniquement quand
l’état change. Le nombre de pannes mécaniques est distinct : il compte les pannes
déclarées manuellement par le Responsable, pas chaque mesure anormale ni chaque
perte de communication. La clôture d’une panne enregistre diagnostic, travaux,
résultat et heure de rétablissement. MTBF suit la convention du TD
`temps en ligne / nombre de pannes confirmées`; MTTR est la moyenne des durées entre
déclaration et rétablissement. Ces durées sont à interpréter avec la couverture et
les historiques disponibles.

La cible SLA n’est pas préconfigurée. Le Responsable peut l’enregistrer depuis la
page Performance via `PUT /api/manager/performance/sla`; le temps hors ligne toléré
est calculé par `(1 - cible) × durée de la période`. Une couverture insuffisante
empêche de déclarer l’objectif respecté ou dépassé.

La page permet aussi de filtrer les alertes par origine et statut, consulter leur
historique, marquer une fausse alerte, enregistrer une panne confirmée et confirmer
son rétablissement. `POST /api/manager/alerts/{id}/false-positive`,
`POST /api/manager/failures`, `GET /api/manager/failures` et
`PATCH /api/manager/failures/{id}/resolve` sont réservés au rôle Responsable.
Les fausses alertes restent consultables dans l’historique, mais ne sont plus
comptées comme alertes actives. La comparaison de machines lit les dernières
mesures par machine et mode à partir des API télémétrie/seuils existantes; elle ne
fabrique pas de mesures absentes.

Limites : les maintenances planifiées et le planning de production ne sont pas
encore historisés; elles ne peuvent donc pas être exclues du SLA. Les pannes et
réparations saisies par le Responsable sont des déclarations métier, pas une preuve
automatique de remise en service. Les indicateurs nouvellement déployés ne peuvent
pas couvrir rétroactivement les transitions antérieures.

Le formulaire de profil partagé avec le Technicien est implémenté dans
`backend/app/static/profile.js`. Les deux espaces réutilisent `GET /api/profile`,
`PATCH /api/profile` et `POST /api/profile/password`. L’API vérifie le mot de passe
actuel, invalide les anciennes sessions après un changement de mot de passe et
déclenche la notification prévue. La récupération « Mot de passe oublié » reste
accessible depuis la page de connexion ; aucun endpoint spécifique au Responsable
n’a été ajouté.

Après une modification du mot de passe, le Responsable est déconnecté et doit se
reconnecter avec le nouveau mot de passe. Le test API
`test_manager_can_update_own_profile_and_password_without_admin_access` vérifie
l’accès au profil, le refus du profil Administrateur et la révocation de session.

### Vérification manuelle et tests

Les tests `test_manager_performance_*`, `test_manager_manual_failure_creation_recovery_and_role_restrictions`,
`test_manager_marks_false_alert_and_history_excludes_it_from_active_count` et
`test_mqtt_status_transitions_are_recorded_once_for_repeated_status` couvrent
respectivement disponibilité/MTBF/MTTR/SLA, pannes, fausses alertes et transitions
MQTT sans doublon. Le scénario de disponibilité multi-machines vérifie l’agrégation
par temps total et non par moyenne des pourcentages.

Dans l’interface, connectez-vous avec un Responsable puis vérifiez :

1. **Vue d’ensemble** : état en ligne/hors ligne, alertes et mesures. Changez de
   mode Réel/Simulé et confirmez que l’origine reste indiquée.
2. **Seuils d’alerte** : choisissez une machine et une grandeur; enregistrez un
   seuil avertissement inférieur au seuil critique. Vérifiez le message de succès
   puis rechargez pour vérifier que les deux valeurs sont relues depuis l’API.
3. **Alertes** : filtrez par origine et statut; ouvrez l’historique; acquittez ou
   clôturez une alerte de test. Pour une alerte active de test, marquez-la fausse
   et confirmez qu’elle apparaît sous le filtre « Fausse alerte » mais plus dans
   le total actif. Les actions modifient l’état partagé de l’alerte.
4. **Interventions** : attribuez une intervention à un compte Technicien actif,
   avec échéance; vérifiez qu’elle apparaît dans le suivi Responsable et dans
   « Mes interventions » du technicien assigné.
5. **Pannes** : déclarez un incident explicitement identifié comme test. Vérifiez
   son auteur et son heure; saisissez diagnostic, travaux et résultat pour
   confirmer le rétablissement. L’action est persistée et ne doit être effectuée
   que pour une panne réellement terminée.
6. **Comparer des machines** : choisissez au moins deux machines et un mode; sans
   télémétrie dans ce mode, l’interface doit indiquer l’absence de mesure plutôt
   que d’afficher un zéro.
7. **Performance** : vérifiez la période, l’heure d’actualisation, la couverture,
   les transitions connues et la configuration SLA. Les transitions anciennes
   absentes ne sont pas estimées.

Pour les essais destructifs ou les changements d’état d’alertes/pannes, utilisez
une base de test ou des éléments explicitement créés pour les essais; ne requalifiez
pas un incident de production.

---

## 5. Acteur 4 — Directeur de production

### Responsabilité et navigation

Le Directeur supervise le parc et consulte les données de production et de
maintenance. Son espace est en lecture seule pour les opérations de maintenance et
d’administration. Après authentification, `app.js` ouvre `#director-app` et
`director.js` gère une navigation sans rechargement entre :

| Page | Fonctionnalités livrées |
|---|---|
| Vue d’ensemble | Disponibilité de supervision, couverture, état MQTT, télémétrie obsolète, alertes et événements récents |
| Indicateurs de disponibilité | Disponibilité basée sur les intervalles de télémétrie fraîche; couverture observée, périodes sans données et MTBF/MTTR des pannes confirmées |
| Durée et fréquence des pannes | Séparation des dépassements critiques et des pannes confirmées; durée d’arrêt et fréquence normalisée sur 30 jours |
| Rapports de maintenance | Synthèse filtrée incluant disponibilité, pannes, coûts estimés, interventions, export CSV et impression/enregistrement PDF |
| Coût des arrêts | Configuration du tarif horaire par machine, historique des modifications et estimation par devise des arrêts confirmés |
| Vue globale des machines | Parc actif, dernier état enregistré et dernière mesure |
| Notifications | Notifications personnelles et action pour les marquer comme lues |
| Mon profil | Formulaire partagé pour modifier ses coordonnées et son mot de passe |

Le menu latéral est fixe sur grand écran et devient rétractable sur mobile. Les
pages utilisent la palette commune et les styles de tableau s’adaptent à l’espace
disponible. Les ressources et le service worker sont versionnés en `v27` ; le shell
précache les modules partagés et les espaces par rôle.

### Périodes, données et indicateurs

Les pages de synthèse, rapports et événements proposent les périodes 7, 30, 90 et
365 jours ainsi qu’un filtre par machine active. Les réponses proviennent des
données SQL persistées ; les requêtes de rapports limitent chacun des historiques
à 300 lignes et signalent cette limite.

Les indicateurs sont recalculés à chaque consultation et la page active se
rafraîchit automatiquement toutes les 10 secondes. Le seuil d’obsolescence est
configurable par l’Administrateur dans les paramètres système
(5–3600 secondes, valeur initiale 30). La disponibilité affichée est une métrique
de **supervision**, pas une disponibilité mécanique : les intervalles de
télémétrie fraîche comptent comme observés/en ligne, les périodes MQTT hors ligne
et les périodes sans mesure fraîche comptent comme indisponibles. La couverture
sépare les durées observées des durées sans état exploitable. Les événements
MQTT antérieurs à leur historisation ne peuvent pas être reconstruits.

Les pannes confirmées proviennent de `ManagerFailureRow`; les alertes et
`MaintenanceFailureRow` restent des dépassements de seuil distincts. La durée
d’arrêt et les coûts utilisent les intervalles confirmés, sans compter deux fois
les chevauchements sur une même machine. Le MTBF reste non calculable sans panne
confirmée ou sans durée de fonctionnement observée; le MTTR reste non calculable
sans rétablissement enregistré. Aucune moyenne n’est remplacée par zéro.

Le Directeur peut enregistrer un tarif horaire par machine et une devise ISO. Le
backend conserve chaque changement avec l’heure et l’identité du Directeur. Les
coûts sont des estimations « durée confirmée × tarif » et les devises sont
totalisées séparément. Sans tarif, l’interface indique la durée non tarifée et
« Tarif à renseigner »; aucun tarif global ou montant réel n’est inventé. Les
durées d’intervention affichées restent distinctes des arrêts machine.

### API et contrôle d’accès

Le routeur `backend/app/api/director.py` est inclus dans `backend/app/main.py`.
Toutes ses routes utilisent `require_roles("director")` :

| Méthode et route | Données retournées |
|---|---|
| `GET /api/director/overview?days=30&machine_id=...` | Parc actif, disponibilité/couverture, fraîcheur télémétrique, pannes confirmées et coûts |
| `GET /api/director/events?days=30&machine_id=...&limit=100` | Événements critiques, état du seuil et dates |
| `GET /api/director/report?days=30&machine_id=...` | Indicateurs, coûts, interventions, pannes confirmées et événements (300 lignes max. par liste) |
| `GET /api/director/costs?days=30&machine_id=...` | Durées d’arrêt et estimations de coût par devise |
| `GET /api/director/cost-rates` | Tarif courant (ou non configuré) pour chaque machine active |
| `PUT /api/director/machines/{machine_id}/cost-rate` | Enregistrer un nouveau tarif, avec identité et horodatage |
| `GET /api/director/cost-rates/history?machine_id=...` | Historique des tarifs et responsables de modification |
| `GET /api/machines` | Liste des machines actives pour alimenter le filtre |
| `GET /api/notifications` | Notifications du compte |
| `POST /api/notifications/{notification_id}/read` | Marquer comme lue une notification appartenant au compte |
| `GET /api/profile`, `PATCH /api/profile` | Lire et modifier son profil |
| `POST /api/profile/password` | Vérifier le mot de passe courant et en changer |

Les filtres de dates personnalisés du backend exigent une paire début/fin valide ;
les périodes relatives acceptent de 1 à 366 jours. Une machine inconnue ou
inactive renvoie une erreur, sans filtrage silencieux. Les opérations de compte
administrateur, de gestion du parc/capteurs/seuils et de maintenance restent
protégées par leurs autorisations existantes ; les tests vérifient notamment que
le Directeur ne peut pas acquitter une alerte.

### Composants et validation

| Besoin | Composants |
|---|---|
| Route après authentification | `backend/app/static/app.js` |
| Navigation, vues, filtres, rapports CSV, profil et notifications | `backend/app/static/director.js` |
| Structure de la barre latérale et du shell | `backend/app/static/index.html` |
| Palette, responsive et impression | `backend/app/static/styles.css` |
| Cache des ressources statiques | `backend/app/static/service-worker.js` |
| API de lecture et agrégations | `backend/app/api/director.py` |
| Machines, alertes, événements critiques et interventions | `backend/app/infrastructure/models.py` |

Le test `test_director_dashboard_reports_only_persisted_data_and_guards_role`
vérifie l’accès par rôle, les données persistées du rapport, les indicateurs
indisponibles, les filtres invalides et l’absence d’une machine inconnue.
`test_web_shell_uses_versioned_assets_and_root_service_worker` vérifie que le
nouveau module et sa version apparaissent dans le shell et le service worker.

### Vérifications manuelles

1. Connectez-vous avec un compte au rôle `director` et confirmez que l’URL reste
   sur la même application pendant la navigation entre les huit pages.
2. Changez la période et la machine ; contrôlez que les compteurs, événements et
   rapports sont filtrés.
3. Vérifiez que l’absence de données affiche « non disponible » ou « inconnu »,
   que les événements critiques ne sont pas nommés pannes confirmées et qu’aucun
   coût n’est affiché.
4. Exportez un rapport CSV puis comparez ses lignes aux interventions et
   événements présents dans l’application ; essayez également l’impression PDF.
5. Marquez une notification comme lue, puis vérifiez son état après rechargement.
6. Modifiez le profil et le mot de passe ; vérifiez la déconnexion puis la
   reconnexion avec le nouveau mot de passe.
7. Testez les largeurs desktop et smartphone dans Opera. Après reconstruction de
   l’image, faites un rechargement forcé une fois ; le shell v15 renouvelle ensuite
   le cache du service worker.

---

## 6. Données, migrations et événements

Les modèles SQLAlchemy dans `backend/app/infrastructure/models.py` couvrent
notamment :

- `users` : identité, rôle, statut, hachage du mot de passe, version de jeton ;
- `machines`, `machine_technician_access`, `sensors` et `thresholds` : parc et
  autorisations ;
- `measurements` : valeurs horodatées, mode d’acquisition, source du courant et
  courant RMS nullable lorsque sa source est indisponible ;
- `alerts` : état, mode d’acquisition nullable pour préserver l’origine inconnue
  des alertes historiques, et `alert_events` : historique de prise en charge ;
- `interventions` : affectation, statut, diagnostic, travail, résultat et révision ;
- `maintenance_failures` et `calibration_records` : historique de maintenance ;
- `technician_notifications`, `user_notifications` : événements destinés aux acteurs ;
- `applied_offline_actions` : idempotence des opérations synchronisées ;
- `login_events`, `admin_activity`, `system_settings` : audit et préférences ;
- `password_reset_tokens`, `password_reset_attempts` : récupération protégée.

`initialize_data()` dans `backend/app/main.py` crée les tables manquantes et applique
des ajouts de colonnes/index compatibles avec les volumes déjà créés. Les valeurs
initiales des mots de passe sont utilisées lors de la création des comptes, et
changer ensuite `.env` ne modifie pas les hachages déjà présents en base. Les
migrations applicatives s’exécutent au démarrage du backend ; sauvegardez la base
avant une mise à jour importante.

---

## 7. Deux modes d’acquisition — utilisés par les acteurs

Les deux modes utilisent le même backend, le même broker, les mêmes API et les mêmes
pages. Il n’est pas nécessaire de changer de base.

### Mode simulé : sans matériel

Le script `backend/app/simulation.py` publie sur
`predimaint/{machine_id}/telemetry` avec le compte MQTT appareil défini dans `.env`.
Le scénario `cycle` alterne valeurs normales, d’avertissement, critiques puis
normales. Le mode d’acquisition et la source du courant sont indiqués comme
`simulated`.

Depuis la racine du dépôt, après avoir créé l’environnement virtuel et démarré Docker :

```powershell
if (-not (Test-Path .venv\Scripts\python.exe)) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
docker compose up -d --build

Push-Location backend
..\.venv\Scripts\python.exe -m app.simulation --machine-id demo-machine --scenario cycle --interval 5
Pop-Location
```

Gardez le terminal du simulateur ouvert ; arrêtez-le avec `Ctrl+C`. Le champ
`--machine-id` doit correspondre à une machine déclarée et autorisée pour le
Technicien. Pour une mesure normale uniquement, utilisez `--scenario normal` ;
pour des valeurs critiques fixes, `--scenario critical`.

### Mode matériel : ESP32, MicroPython et Thonny

Le firmware `firmware/main.py` s’exécute sur l’ESP32 via Thonny. Configurez
`firmware/config.example.json` dans le fichier `/config.json` de la carte :

- réseau Wi-Fi ;
- adresse IP du PC sur le réseau ;
- port MQTT publié par Docker (1884 par défaut) ;
- identifiants MQTT de l’appareil ;
- `machine_id` identique à la machine déclarée dans l’application.

Le firmware publie notamment température DHT22 et événements numériques HW-072. Le
courant peut rester simulé tant que l’ACS712, l’entrée ADC, le diviseur de tension
et la calibration n’ont pas été validés. Le mode `hardware` décrit le parcours de
mesure par l’ESP32 ; il ne signifie pas que toutes les grandeurs, en particulier le
courant, sont acquises matériellement. Ne branchez pas le secteur à l’ESP32 ou à une
breadboard.

### Dépannage : « le simulateur publie mais aucune mesure n’apparaît »

1. Confirmez que Docker est actif : `docker compose ps`.
2. Vérifiez que le broker et le backend sont démarrés ; consultez
   `docker compose logs --tail 100 backend mosquitto`.
3. Vérifiez que `machine_id` dans la commande de simulation est exactement
   l’identifiant de machine déclaré.
4. Vérifiez que l’API répond : `Invoke-RestMethod http://localhost:8001/api/health`.
5. Connectez-vous en Technicien et demandez au Responsable une intervention ou une
   autorisation sur cette machine. Les mesures d’une machine non autorisée sont
   volontairement filtrées.
6. Vérifiez la page « Mesures des capteurs » : choisissez la machine, une grandeur
   et une période qui inclut l’horodatage des publications.
7. Si la publication continue mais que la mesure ne se stocke pas, examinez les
   logs backend pour les messages MQTT ignorés ou erreurs de traitement.

---

## 8. Exécuter l’application et valider les acteurs

### Démarrage commun

À la racine du dépôt, dans PowerShell :

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:8001/api/health
```

Ouvrez `http://localhost:8001`. L’API de documentation est disponible à
`http://localhost:8001/docs`. La base PostgreSQL n’a pas à être supprimée pour
mettre à jour l’image ; **n’utilisez pas** `docker compose down -v` sauf si vous
voulez expressément effacer les volumes et les données associées.

Le navigateur reçoit des URL de ressources versionnées et le service worker racine
est vérifié à chaque chargement, quel que soit le rôle. Après une mise à jour,
ouvrez de nouveau l’application ou faites un rechargement forcé (`Ctrl+Shift+R`)
si un onglet était déjà ouvert.

### Scénarios de test — Administrateur système

1. Connectez-vous avec un compte de rôle `admin` ; vérifiez que la navigation
   administrateur apparaît et que l’espace Technicien n’est pas affiché.
2. Dans la vue d’ensemble, comparez le nombre de comptes, les rôles et les
   dernières activités aux données présentes.
3. Recherchez un utilisateur, filtrez par rôle/statut, puis modifiez ses coordonnées.
   Vérifiez la notification intégrée et l’état d’envoi du courriel si SMTP est actif.
4. Créez un compte de test avec un mot de passe d’au moins 12 caractères ; testez
   ensuite sa connexion et son rôle.
5. Désactivez puis réactivez ce compte ; confirmez qu’un jeton obtenu avant la
   désactivation n’autorise plus les appels API.
6. Vérifiez qu’une tentative de désactiver le dernier administrateur actif est
   refusée. Vérifiez qu’un administrateur ne peut pas supprimer son propre compte.
7. Essayez de supprimer un compte ayant un historique d’interventions : le serveur
   doit demander de désactiver plutôt que d’effacer les données d’audit.
8. Consultez historique des connexions, journal d’activité et notifications.
9. Modifiez le profil et changez le mot de passe depuis le profil ; l’ancien jeton
   doit être révoqué.
10. Testez « Mot de passe oublié ? » avec SMTP fonctionnel : le lien reçu ne doit
    fonctionner qu’une fois et expirer après 15 minutes. Vérifiez également la
    réponse générique pour une adresse inconnue.
11. Modifiez les préférences, puis reconnectez-vous pour vérifier la durée des
    nouveaux jetons. Les jetons déjà émis ne changent pas de date d’expiration.
12. Dans **Sauvegardes PostgreSQL**, créez une sauvegarde et vérifiez sa date,
    taille et son statut; téléchargez-la et consultez l’historique. Testez le refus
    d’accès pour un compte non administrateur. Pour tester l’automatisation,
    choisissez temporairement un intervalle d’une minute, attendez la sauvegarde,
    puis remettez l’intervalle souhaité.

### Scénarios de test — Technicien de maintenance

1. Faites attribuer une intervention par un Responsable à un Technicien et à une
   machine. Connectez-vous à nouveau au compte Technicien.
2. Vérifiez que le tableau affiche ses indicateurs et les éléments autorisés ; les
   machines d’autres affectations ne doivent pas apparaître.
3. Lancez le simulateur sur l’identifiant de cette machine et consultez les mesures
   sur une période incluant les nouvelles lectures.
4. Avec le scénario `cycle`, observez les alertes et événements associés aux
   dépassements de seuil. Prenez en charge une alerte et vérifiez son historique.
5. Mettez une intervention à « En cours », renseignez le diagnostic et le travail
   réalisé, enregistrez, puis rechargez pour vérifier la persistance.
6. Consultez l’historique critique, ajoutez un diagnostic et vérifiez qu’un seuil
   dépassé n’est pas automatiquement présenté comme une panne confirmée.
7. Lisez une notification et marquez-la comme lue.
8. Créez une calibration ; vérifiez que la fiche est historisée sans modifier les
   seuils ni le firmware.
9. Testez l’hors-ligne après avoir chargé l’application en ligne : préparez un
   brouillon, confirmez qu’il reste local/en attente, rétablissez le réseau puis
   synchronisez. Vérifiez le comportement en cas de conflit de révision.
10. Vérifiez « Mon profil », le changement de mot de passe et l’affichage responsive.
11. Répétez la connexion avec chaque compte Technicien concerné ; les comptes
    partagent le même tableau, mais chaque liste de machines reste limitée aux
    autorisations de ce compte.
12. Dans « Mes machines », vérifiez la fiche détaillée avec une mesure simulée
    puis une mesure matérielle; comparez les capteurs, alertes et valeurs avec
    celles renvoyées par l’API. Essayez l’URL d’une machine non autorisée : l’API
    doit répondre `404`.
13. Dans une intervention attribuée, joignez une image PNG/JPEG/WebP, rechargez la
    page puis consultez-la. Essayez un fichier texte et une intervention d’un
    autre Technicien : les demandes doivent être refusées. Un redémarrage normal
    `docker compose restart backend` doit conserver le fichier; ne supprimez pas
    les volumes Docker.
14. Pour tester Web Push, configurez d’abord des clés VAPID, servez la page en
    HTTPS (ou `localhost`), accordez la permission navigateur, activez les
    notifications et déclenchez une alerte/intervention de test. Vérifiez aussi
    le refus quand les clés ne sont pas configurées. Les tests automatisés
    simulent l’acceptation par le service Push; ils ne remplacent pas ce test réel.
15. Pour le délai US-43, déclenchez une alerte et relevez le délai de traitement
    backend puis le délai jusqu’à l’accusé de réception dans l’application. Les
    anciennes alertes et l’heure de capture physique ne disposent pas de ces
    informations; la mesure d’acquisition firmware reste à ajouter si elle est
    nécessaire.

**Contrôle ciblé des mesures en direct**

- Dans « Mesures des capteurs », gardez le mode « Réel » et vérifiez que les
  valeurs, statistiques et graphique se mettent à jour toutes les 5 secondes
  sans rechargement complet.
- Sélectionnez successivement Humidité, Vibrations et Courant ; attendez au
  moins deux cycles après chaque sélection et confirmez que le graphique ne
  revient pas à Température.
- Comparez une valeur récente avec la publication « Publié : » de Thonny. En
  débranchant l’ESP32, vérifiez que l’âge augmente puis que l’interface indique
  les données obsolètes après 30 secondes. Ce test matériel n’est pas remplacé
  par les tests automatisés avec réponses API simulées.

### Scénarios de test — Responsable de maintenance

1. Connectez-vous avec un compte `manager` : une barre latérale dédiée doit
   apparaître, sans le menu Administrateur ni l’ancienne barre publique.
2. Ouvrez successivement Vue d’ensemble, Alertes, Interventions, Parc et capteurs,
   Seuils d’alerte, Performance et Mon profil ; chaque page doit s’afficher sans
   recharger le site.
3. Créez une intervention pour un Technicien, puis vérifiez qu’elle apparaît dans
   Interventions et dans le compte Technicien affecté.
4. Modifiez un seuil ou une fiche de machine/capteur, puis vérifiez les données après
   actualisation.
5. Dans Performance, vérifiez que les indicateurs non calculables sont signalés
   comme indisponibles, sans nombres d’exemple présentés comme des mesures réelles.
6. Modifiez les coordonnées du Responsable, puis son mot de passe ; confirmez la
   déconnexion et reconnectez-vous avec le nouveau mot de passe.
7. Depuis la page de connexion, testez également le lien « Mot de passe oublié ? ».
8. En largeur mobile, ouvrez le menu avec ☰, naviguez vers Mon profil, puis
   déconnectez-vous depuis le menu.

### Scénarios de test — Directeur de production

Dans l’espace Directeur, vérifiez l’actualisation de la page active, les filtres
par période, machine et mode, ainsi que les vues d’ensemble, disponibilité,
pannes, rapports, notifications et profil. Dans Coût des arrêts, enregistrez un
tarif de test sur une machine de test, vérifiez l’identité et l’historique puis
confirmez que les devises restent séparées. Vérifiez le refus des routes de
tarification pour un rôle non Directeur. Les essais de panne doivent utiliser une
déclaration contrôlée du Responsable; une alerte de capteur seule ne constitue
pas une panne confirmée. Pour valider la couverture et le statut obsolète,
attendez au-delà du seuil configuré ou utilisez un jeu de données isolé.

### Tests automatisés et vérifications front-end

Avec Docker démarré :

```powershell
docker compose exec -T backend pytest -q
```

Depuis la racine du dépôt, les contrôles de syntaxe utilisés pour les fichiers
statiques et Python sont :

```powershell
node --check backend\app\static\app.js
node --check backend\app\static\admin.js
node --check backend\app\static\profile.js
node --check backend\app\static\technician.js
node --check backend\app\static\service-worker.js
python -m py_compile backend\app\main.py backend\app\api\routes.py backend\app\api\admin.py backend\app\api\auth.py
```

Les tests API utilisent une base SQLite isolée et remplacent les envois SMTP ; ils
ne valident donc pas la livraison réelle d’un e-mail Brevo ni l’acquisition physique
par une carte ESP32.

---

## 9. Sécurité, exploitation et limites connues

- Remplacez les secrets de développement et les secrets précédemment exposés avant
  tout usage partagé. Utilisez des mots de passe uniques pour PostgreSQL, JWT et
  chaque compte MQTT.
- Ne versionnez jamais `.env`, les mots de passe Mosquitto, les configurations
  privées du firmware ou les secrets SMTP.
- Le MQTT local utilise authentification et ACL ; le profil courant ne configure
  pas TLS. Ne rendez pas le broker accessible depuis un réseau non fiable.
- Le cache des données Technicien est enregistré dans le navigateur. Les comptes
  partagent un appareil à leurs risques ; déconnectez-vous et synchronisez les
  brouillons avant d’effacer les données du site ou de changer d’appareil.
- Les notifications externes sont par courriel SMTP. WhatsApp n’est pas intégré.
- Les règles d’alerte actuelles sont des seuils ; elles ne constituent pas une
  prédiction statistique ou une preuve de panne matérielle.
- L’espace Directeur et ses rapports sont présents. Les indicateurs qui demandent
  un historique d’arrêts confirmés ou des paramètres économiques restent
  explicitement indisponibles; ne présentez pas les valeurs de la maquette comme
  des données de production.
- La calibration dans l’application est un enregistrement de maintenance ; elle ne
  reprogramme pas automatiquement un capteur.

## 10. Références de code

- Démarrage, données initiales, migrations et routes statiques :
  `backend/app/main.py`
- Authentification et rôles :
  `backend/app/api/auth.py`
- API communes, Technicien, interventions, accès machine et récupération :
  `backend/app/api/routes.py`
- API Administrateur :
  `backend/app/api/admin.py`
- Schéma SQLAlchemy :
  `backend/app/infrastructure/models.py`
- Réception MQTT et persistance/événements :
  `backend/app/infrastructure/mqtt_client.py`,
  `backend/app/infrastructure/repository.py`
- Interface et thème :
  `backend/app/static/index.html`,
  `backend/app/static/app.js`,
  `backend/app/static/admin.js`,
  `backend/app/static/profile.js`,
  `backend/app/static/technician.js`,
  `backend/app/static/styles.css`,
  `backend/app/static/service-worker.js`
- Mode simulé et mode matériel :
  `backend/app/simulation.py`,
  `firmware/main.py`,
  `firmware/config.example.json`
- Guide Release 1 et procédures de test :
  `README_RELEASE_1.md`

