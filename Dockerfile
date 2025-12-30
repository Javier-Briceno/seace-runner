FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
