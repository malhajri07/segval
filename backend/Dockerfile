FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml ./
COPY segval ./segval
RUN pip install --no-cache-dir .
ENV SEGVAL_NEO4J_URI=bolt://neo4j:7687
EXPOSE 8000
CMD ["uvicorn", "segval.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
