# PrediSens

> **Écoutez vos machines avant qu'elles ne s'arrêtent.**

Plateforme IoT de **maintenance prédictive** pour moteurs et machines tournantes. PrediSens mesure en continu la vibration, la température et le courant d'une machine, détecte les dérives de fonctionnement et alerte les techniciens **avant** la panne.

Projet d'intégration (ECUE352) du Master Professionnel Co-construit M2 — parcours DS-IoT, **ISET Mahdia**, réalisé par une équipe de 4 étudiants avec la méthode **Agile Scrum**.

---

## Sommaire

- [Présentation générale](#présentation-générale)
- [Fonctionnalités principales](#fonctionnalités-principales)
- [Architecture](#architecture)
- [Outils et technologies](#outils-et-technologies)
- [Structure du dépôt](#structure-du-dépôt)
- [Installation et lancement](#installation-et-lancement)
- [Organisation du projet](#organisation-du-projet)
- [Équipe](#équipe)

---

## Présentation générale

### Le problème

Un arrêt machine imprévu coûte cher : production perdue, délais non tenus, réparations en urgence.

- La **maintenance corrective** répare après la panne.
- La **maintenance préventive systématique** remplace parfois des pièces encore saines.
- Les solutions de maintenance prédictive du marché sont souvent coûteuses, liées à un cloud propriétaire et pensées pour de grands parcs de machines.

### La solution

PrediSens propose une alternative **ouverte, modulaire et à faible coût**, adaptée aux PME industrielles : mesurer l'état de santé de la machine en temps réel et intervenir au bon moment.

### Utilisateurs cibles

| Acteur | Usage |
|---|---|
| Technicien de maintenance | Reçoit les alertes, consulte l'historique, enregistre ses interventions |
| Responsable maintenance | Supervise le parc, configure les seuils, planifie les interventions |
| Direction de production | Suit les indicateurs de disponibilité |
| Administrateur | Gère les comptes et les droits |

---

## Fonctionnalités principales

- Acquisition de la **vibration**, de la **température** et du **courant** d'une machine
- Pré-traitement en périphérie sur l'ESP32 (RMS, pics de fréquence par FFT)
- Transmission temps réel et sécurisée via **MQTT (TLS)**, avec mémoire tampon en cas de coupure réseau
- Stockage des mesures en base de séries temporelles
- Détection d'anomalies à deux niveaux : **seuils configurables** puis **modèle d'apprentissage automatique**
- Alertes à deux niveaux (avertissement / critique) avec notifications push et e-mail
- **Tableau de bord web** temps réel
- **Application mobile** pour les techniciens
- Gestion du parc de machines, des interventions et des utilisateurs (rôles)
- Indicateurs de maintenance (disponibilité, MTBF, MTTR)

---

## Architecture

PrediSens est organisée en quatre couches :

```
Machine (capteurs)  →  ESP32  →  Broker MQTT  →  Backend  →  Dashboard web
                                                          →  Application mobile
```

| Couche | Composants | Rôle |
|---|---|---|
| **Capteurs / Périphérie** | Accéléromètre, DS18B20, capteur de courant, ESP32 | Mesurer et pré-traiter |
| **Réseau** | Wi-Fi, MQTT sur TLS, broker Mosquitto | Transporter les mesures de façon fiable et sécurisée |
| **Plateforme** | API FastAPI, service d'ingestion, InfluxDB, PostgreSQL, service d'analyse, moteur d'alertes | Stocker, analyser, détecter, alerter |
| **Application** | Grafana, application Flutter, Firebase Cloud Messaging, e-mail | Informer et permettre d'agir |

**Convention des topics MQTT**

```
predisens/<site>/<machine>/<capteur>/mesures
predisens/<site>/<machine>/statut
```

---

## Outils et technologies

### Matériel (IoT)

![ESP32](https://img.shields.io/badge/ESP32-E7352C?style=for-the-badge&logo=espressif&logoColor=white)
![ADXL345](https://img.shields.io/badge/ADXL345-555555?style=for-the-badge)
![DS18B20](https://img.shields.io/badge/DS18B20-555555?style=for-the-badge)
![SCT-013](https://img.shields.io/badge/SCT--013-555555?style=for-the-badge)

| Élément | Choix |
|---|---|
| Microcontrôleur | **ESP32** (Wi-Fi) |
| Vibration | Accéléromètre MEMS (type **ADXL345**) |
| Température | **DS18B20** |
| Courant | Pince non invasive **SCT-013** avec circuit de conditionnement (ACS712 comme alternative) |
| Banc de démonstration | Moteur ou ventilateur simulant une machine |

### Firmware

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Arduino](https://img.shields.io/badge/Arduino-00878F?style=for-the-badge&logo=arduino&logoColor=white)

### Communication

![MQTT](https://img.shields.io/badge/MQTT-660066?style=for-the-badge&logo=mqtt&logoColor=white)
![Mosquitto](https://img.shields.io/badge/Mosquitto-3C5280?style=for-the-badge&logo=eclipsemosquitto&logoColor=white)
![JSON](https://img.shields.io/badge/JSON-000000?style=for-the-badge&logo=json&logoColor=white)
![TLS](https://img.shields.io/badge/TLS-2E7D32?style=for-the-badge&logo=letsencrypt&logoColor=white)

MQTT avec TLS et authentification, broker **Eclipse Mosquitto**, messages au format **JSON** (QoS 1).

### Backend

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white)
![OpenAPI](https://img.shields.io/badge/OpenAPI-6BA539?style=for-the-badge&logo=openapiinitiative&logoColor=white)
![InfluxDB](https://img.shields.io/badge/InfluxDB-22ADF6?style=for-the-badge&logo=influxdb&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)

API REST documentée (OpenAPI), authentification **JWT** avec contrôle d'accès par rôle, **InfluxDB** pour les mesures (séries temporelles), **PostgreSQL** pour les machines, utilisateurs, interventions et alertes.

### Analyse et détection d'anomalies

![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![scikit-learn](https://img.shields.io/badge/scikit--learn-F7931E?style=for-the-badge&logo=scikitlearn&logoColor=white)

Isolation Forest (ou équivalent) pour le niveau 2, et règles de seuils inspirées de la norme **ISO 20816** pour le niveau 1.

### Interfaces

![Grafana](https://img.shields.io/badge/Grafana-F46800?style=for-the-badge&logo=grafana&logoColor=white)
![Flutter](https://img.shields.io/badge/Flutter-02569B?style=for-the-badge&logo=flutter&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)
![Gmail](https://img.shields.io/badge/Gmail-EA4335?style=for-the-badge&logo=gmail&logoColor=white)

**Grafana** pour le tableau de bord web, **Flutter** pour l'application mobile, **Firebase Cloud Messaging** pour les notifications push, e-mail pour les alertes.

### DevOps et gestion de projet

![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Git](https://img.shields.io/badge/Git-F05032?style=for-the-badge&logo=git&logoColor=white)
![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white)
![Trello](https://img.shields.io/badge/Trello-0052CC?style=for-the-badge&logo=trello&logoColor=white)
![Jira](https://img.shields.io/badge/Jira-0052CC?style=for-the-badge&logo=jira&logoColor=white)

**Docker Compose** pour un déploiement reproductible, **GitHub** (branches par fonctionnalité, pull requests) et **GitHub Actions** pour l'intégration continue, **Trello** ou **Jira** pour le tableau Scrum.

---

## Structure du dépôt

> À adapter selon l'organisation réelle du code.

```
predisens/
├── firmware/        # Code ESP32 (Arduino / PlatformIO)
├── backend/         # API FastAPI, ingestion MQTT, moteur d'alertes
├── analytics/       # Détection d'anomalies (scikit-learn)
├── mobile/          # Application Flutter
├── dashboard/       # Configuration Grafana
├── docker/          # Docker Compose, config Mosquitto, bases de données
├── docs/            # Cahier des charges, documentation produit
└── README.md
```

---

## Installation et lancement

> Section à compléter au fil du développement.

```bash
# 1. Cloner le dépôt
git clone https://github.com/<organisation>/predisens.git
cd predisens

# 2. Configurer les variables d'environnement
cp .env.example .env

# 3. Lancer la plateforme (broker, bases de données, API, Grafana)
docker compose up -d
```

- **Firmware** : ouvrir `firmware/` avec PlatformIO ou Arduino IDE, renseigner le Wi-Fi, l'adresse du broker et l'identifiant de la machine, puis téléverser sur l'ESP32.
- **Application mobile** : `cd mobile && flutter pub get && flutter run`.

> Aucun secret (mots de passe, clés) ne doit être versionné dans le dépôt.

---

## Organisation du projet

- **Méthode** : Agile Scrum, sprints de 2 semaines
- **Durée** : 14 semaines (Sprint 0, Sprints 1 à 4, stabilisation, documentation, soutenance)
- **Product Owner** : l'enseignant encadrant
- **Livrables** : cahier des charges, firmware, backend et application mobile versionnés, maquette de démonstration, documentation produit, soutenance devant jury

---

## Équipe

Équipe de 4 étudiants du Master DS-IoT — ISET Mahdia.

| Nom | Rôle |
|---|---|
| … | … |
| … | … |
| … | … |
| … | … |

**Encadrement** : Mounir Abida — Maître Technologue, ISET Mahdia

---

## Licence

À définir.
