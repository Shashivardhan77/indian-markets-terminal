FROM node:22-alpine
WORKDIR /app
COPY server.js ./server.js
COPY public ./public
COPY data ./data
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
