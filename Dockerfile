FROM denoland/deno:2.4.3

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p cache tmp

ENV PORT=8000

EXPOSE 8000

CMD ["deno", "run", \
     "--allow-net", \
     "--allow-read", \
     "--allow-write", \
     "--allow-run", \
     "--allow-env", \
     "server.ts"]