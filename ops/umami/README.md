# Umami auto-hébergé

Cette installation héberge les statistiques de Flamap sur le VPS accessible
avec l'alias SSH `vps-ecmwf`. Elle est volontairement bridée pour que son
dysfonctionnement ne puisse pas accaparer les ressources des autres services.

Les fichiers de ce dossier sont les copies de référence des fichiers installés
sur le serveur. Aucun secret n'est conservé dans le dépôt.

## État au 29 juillet 2026

- Ubuntu 26.04 LTS ;
- Docker 29.1.3 et Docker Compose 2.40.3 ;
- Umami 3.1.0 ;
- PostgreSQL 15 Alpine ;
- application et base saines ;
- sauvegarde PostgreSQL testée avec succès ;
- Nginx configuré pour `analytics.flamap.fr` ;
- DNS actif et certificat Let's Encrypt installé, avec renouvellement automatique.

Le site `Flamap` existe déjà dans Umami. Le mot de passe `admin / umami` a été
remplacé par un secret fort.

## Architecture

Nginx est le seul point d'entrée public. Umami écoute seulement sur
`127.0.0.1:3000` et PostgreSQL n'expose aucun port sur l'hôte.

Deux réseaux Docker sont utilisés :

- `umami-backend`, interne, relie uniquement Umami à PostgreSQL ;
- `umami-frontend`, relie Umami au port local publié pour Nginx.

Le tableau de bord est protégé deux fois : authentification HTTP Nginx, puis
authentification Umami. Seuls `/script.js` et `/api/send` sont publics.

## Ressources et garde-fous

Les plafonds cgroup sont des limites strictes :

| Conteneur | CPU | RAM | Swap | Processus |
|---|---:|---:|---:|---:|
| Umami | 0,75 CPU | 768 Mio | aucun | 200 |
| PostgreSQL | 0,50 CPU | 640 Mio | aucun | 100 |

Au total, Umami ne peut donc pas prendre plus de 1,25 des 2 CPU ni plus de
1,4 Gio de RAM. Un swap de secours de 2 Gio existe pour le reste du VPS, avec
`vm.swappiness=10`, mais les conteneurs Umami ne peuvent pas l'utiliser.

Les journaux Docker utilisent le pilote `local`, limité à trois fichiers de
10 Mio par conteneur.

`umami-guard.timer` vérifie le stockage toutes les cinq minutes :

- base PostgreSQL supérieure à 10 Gio : arrêt de la collecte Umami ;
- moins de 8 Gio libres : arrêt de la collecte Umami ;
- moins de 5 Gio libres : arrêt de PostgreSQL également.

Le contrôleur n'efface jamais de données et ne redémarre pas automatiquement
un service bloqué. La raison est écrite dans
`/var/lib/umami-guard/blocked`.

La collecte est aussi limitée par Nginx à 20 requêtes par seconde et par
adresse IP, avec une courte rafale de 40 requêtes.

## Commandes courantes

Toutes les commandes d'exploitation nécessitent `sudo`, car les secrets et la
configuration du serveur ne sont pas lisibles par l'utilisateur SSH normal.

État :

```bash
ssh vps-ecmwf
sudo sh -c 'cd /opt/umami && docker compose ps'
sudo docker stats --no-stream
curl -fsS http://127.0.0.1:3000/api/heartbeat
```

Démarrer ou remettre la configuration en application :

```bash
sudo sh -c 'cd /opt/umami && docker compose up -d'
```

Arrêter uniquement la collecte, en laissant PostgreSQL disponible :

```bash
sudo docker stop umami-app
```

Arrêter toute la pile :

```bash
sudo sh -c 'cd /opt/umami && docker compose stop'
```

Voir les journaux :

```bash
sudo docker logs --tail 100 umami-app
sudo docker logs --tail 100 umami-db
sudo journalctl -t umami-guard --since today
sudo journalctl -t umami-backup --since today
```

Surveiller le stockage :

```bash
df -h /
sudo du -sh /var/lib/docker/volumes/umami-db-data/_data
sudo du -sh /var/backups/umami
```

## Identifiants

Les secrets ont été générés directement sur le VPS. Ils ne doivent jamais être
copiés dans ce dépôt.

Pour afficher les deux identifiants du tableau de bord et l'identifiant du
site :

```bash
sudo cat /root/umami-admin-credentials
```

Le fichier de variables Docker est `/opt/umami/.env`. Il contient le mot de
passe PostgreSQL et `APP_SECRET`.

## DNS et HTTPS

La zone OVH contient l'entrée :

```text
analytics.flamap.fr  A  <IPv4 du VPS vps-ecmwf>
```

Le certificat a été émis le 29 juillet 2026. Certbot renouvelle automatiquement
le certificat et recharge Nginx. Contrôles utiles :

```bash
ssh vps-ecmwf
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t
curl -I https://analytics.flamap.fr/script.js
```

## Tracker installé sur Flamap

La balise Umami Cloud a été remplacée par :

```html
<script
  defer
  src="https://analytics.flamap.fr/script.js"
  data-website-id="<WEBSITE_ID>"
  data-domains="flamap.fr,www.flamap.fr"
  data-exclude-search="true"
  data-exclude-hash="true"
  data-do-not-track="true">
</script>
```

Les paramètres de recherche et fragments d'URL sont volontairement exclus.
Ne pas activer `umami.identify`, le replay de sessions ni les cartes de
chaleur si l'objectif reste une mesure d'audience minimale sans fenêtre de
consentement.

## Sauvegardes

`umami-backup.timer` crée chaque nuit, vers 03:20 UTC, un dump PostgreSQL
compressé et vérifié dans `/var/backups/umami`. Les sauvegardes locales de plus
de 14 jours sont supprimées.

Créer et vérifier une sauvegarde immédiatement :

```bash
sudo systemctl start umami-backup.service
systemctl status umami-backup.service
sudo ls -lh /var/backups/umami
```

Ces sauvegardes protègent contre une erreur de base, mais pas contre la perte
du VPS. Il reste recommandé de recopier périodiquement ce dossier vers un
stockage hors serveur.

Avant toute restauration, arrêter `umami-app`, conserver une sauvegarde de
sécurité et vérifier le contenu du dump avec :

```bash
sudo docker exec -i umami-db pg_restore -l \
  < /var/backups/umami/<sauvegarde>.dump
```

## Déblocage après saturation

Lire d'abord la raison et libérer de l'espace ou corriger la politique de
conservation :

```bash
sudo cat /var/lib/umami-guard/blocked
df -h /
```

Une fois le problème réellement corrigé :

```bash
sudo rm /var/lib/umami-guard/blocked
sudo sh -c 'cd /opt/umami && docker compose up -d'
sudo systemctl start umami-guard.service
```

## Mise à jour

Ne pas passer aveuglément à `latest`. Lire les notes de version, créer une
sauvegarde puis modifier `UMAMI_IMAGE` dans `/opt/umami/.env`.

```bash
sudo systemctl start umami-backup.service
sudoedit /opt/umami/.env
sudo sh -c 'cd /opt/umami && docker compose pull && docker compose up -d'
curl -fsS http://127.0.0.1:3000/api/heartbeat
```

Après une mise à jour majeure, rafraîchir les statistiques PostgreSQL :

```bash
sudo docker exec umami-db psql -U umami -d umami -c 'ANALYZE;'
```

Vérifier enfin que `ecmwf-meteograms.service` et Nginx sont toujours actifs.

## Fichiers installés sur le VPS

- `/opt/umami/docker-compose.yml` et `/opt/umami/.env` ;
- `/usr/local/sbin/umami-guard` ;
- `/usr/local/sbin/umami-backup` ;
- unités `umami-guard.*` et `umami-backup.*` dans systemd ;
- `/etc/nginx/sites-available/umami` ;
- `/etc/nginx/conf.d/umami-rate-limit.conf` ;
- `/etc/nginx/.htpasswd-umami` ;
- `/root/umami-admin-credentials`.
