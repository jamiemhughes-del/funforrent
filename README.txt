# FunForRent - Deployment Package

## What's Included
- `dist/public/` - Built website (HTML, CSS, JS, images)
- `server-checkout.js` - Backend that creates Square payment links
- `Dockerfile` - Container config for Render/Railway/Docker
- `.env` - Production Square credentials
- `package.json` - Minimal dependencies

## Deploy to Render (Easiest)

### Step 1: Create ZIP
Zip this entire folder:
```bash
cd funforrent-deploy
zip -r ../funforrent.zip .
```

### Step 2: Upload to Render
1. Go to https://render.com
2. Sign up / Log in
3. Click "New +" → "Web Service"
4. Choose "Deploy from Dockerfile"
5. Upload the ZIP file
6. Set environment variables (below)
7. Click "Create Web Service"

### Step 3: Environment Variables
These are already in the `.env` file. Render will auto-load them if you upload the whole folder. If not, add manually:

| Key | Value |
|-----|-------|
| SQUARE_APPLICATION_ID | sq0idp-HcA2zyhO7ad7r08AOaSE_g |
| SQUARE_ACCESS_TOKEN | EAAAlxFFXVv3X4emKCL5gyOYX2NxZKcDEOPnbFNflXlVFUr4EIqT9Mv6v-HKwsY9 |
| SQUARE_ENVIRONMENT | production |
| SQUARE_LOCATION_ID | LTG9DZYS8F4FY |

### Step 4: Test
Once deployed (takes ~3 minutes), go to your Render URL:
1. Add an item to cart
2. Fill in details
3. Click "Pay"
4. You should be redirected to Square's secure checkout page
5. Enter a real card
6. Money goes to your Square account!

## Deploy to Any Docker Host
```bash
docker build -t funforrent .
docker run -p 3000:3000 --env-file .env funforrent
```

## Test Card for Sandbox (if you switch back to sandbox)
| Field | Value |
|-------|-------|
| Card | 4111 1111 1111 1111 |
| Expiry | 12/30 |
| CVV | 111 |

## Support
If the checkout fails, check Render logs for error messages.
