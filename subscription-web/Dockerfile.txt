# --- Стадия 1: сборка фронтенда ---
FROM node:20-slim AS ui
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Стадия 2: рантайм ---
FROM python:3.11-slim
WORKDIR /app/backend
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY backend/ /app/backend/
COPY --from=ui /app/frontend/dist /app/frontend/dist

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
