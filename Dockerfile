# Один образ: собираем фронтенд, шлюз отдаёт его вместе с API
FROM node:22-alpine AS front
WORKDIR /front
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npx vite build

FROM python:3.12-slim
WORKDIR /app/gateway
COPY gateway/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY gateway/ ./
COPY demo/ /app/demo/
COPY --from=front /front/dist /app/frontend/dist
ENV SENSORWATCH_FRONTEND_DIST=/app/frontend/dist
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
