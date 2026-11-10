# The Floor Store · Store Schedules

Live schedule for all store locations: Today, Week, Month, PTO and Edit views.
Static page (`index.html`) plus one Netlify Function (`netlify/functions/api.mjs`) that saves data in Netlify Blobs.

## Deploy
1. Put these files in a new GitHub repo.
2. Netlify: Add new site > Import an existing project > GitHub > pick the repo. Leave build settings as they are and deploy.
3. Netlify: Site configuration > Environment variables > add `MANAGER_PIN` (for example `4821`), then redeploy.
   Anyone can view; edits ask for this PIN. Leave it unset to let anyone edit.

The first visit loads the regular schedules from the Canva file. After that, all changes are stored in Netlify Blobs and survive redeploys.
