FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN apt-get update && apt-get install -y python3 make g++ && npm install --omit=dev
COPY . .
ENV DB=/data/leads.db PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
