# Correction – photos des interventions

## Modifications apportées

- `app/static/app.js` : le manager recharge la liste des photos à chaque ouverture de « Compte rendu et photos ». Une liste vide n'est plus mémorisée comme un résultat définitif. Les anciennes URLs temporaires des images sont libérées avant le rechargement.
- `app/static/technician.js` : l'envoi vérifie qu'au moins une photo est sélectionnée, bloque les fichiers de plus de 8 Mio avant l'envoi et affiche une confirmation avec le nombre de photos réellement enregistrées. Le formulaire utilise `FormData` (sans définir manuellement l'en-tête `Content-Type`).
- `app/static/index.html` et `app/static/service-worker.js` : version du cache augmentée à `v36` pour obliger le navigateur à récupérer les nouveaux scripts.
- `tests/test_api.py` : ajout d'une vérification qui prouve qu'après l'envoi par le technicien, le manager peut lister la photo et récupérer les mêmes octets du fichier.

Les routes API d'envoi, de liste et de lecture des photos existaient déjà et permettent les rôles technicien et manager. Le problème d'interface venait notamment du résultat vide conservé dans la galerie du manager.

## Mise en place

1. Remplacer le dossier `backend` du projet par le dossier `backend` de cette archive.
2. Depuis le dossier racine du projet (celui qui contient `docker-compose.yml`), reconstruire et redémarrer :

   ```powershell
   docker compose up --build -d
   ```

3. Recharger les deux navigateurs avec `Ctrl + F5` (technicien et manager).

## Test fonctionnel

1. Se connecter comme technicien.
2. Ouvrir « Mes interventions », puis l'intervention concernée et « Photos de l'intervention ».
3. Choisir une image JPEG, PNG ou WebP de moins de 8 Mio et cliquer sur « Joindre les photos ».
4. Vérifier le message vert de confirmation indiquant que la photo est envoyée et enregistrée.
5. Se connecter comme manager, ouvrir la même intervention, puis « Compte rendu et photos ».
6. Si la section avait déjà été ouverte avant l'envoi et affichait « Aucune photo jointe », la fermer puis la rouvrir : la liste sera redemandée au serveur et l'image apparaîtra.

## Stockage en production

Les fichiers sont conservés dans `INTERVENTION_PHOTO_DIRECTORY` (valeur par défaut : `/var/lib/predimaint/intervention-photos`). En déploiement Docker ou cloud, ce répertoire doit être monté sur un stockage persistant et partagé avec toutes les instances du backend. Sinon, les fichiers locaux peuvent disparaître lors d'une recréation du conteneur ou ne pas être accessibles depuis une autre instance, même si leurs métadonnées sont toujours présentes en base.
