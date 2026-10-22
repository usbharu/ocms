FROM groonga/pgroonga:4.1.0-alpine-17
RUN apk add --no-cache --virtual .vector-build build-base wget \
 && wget -qO /tmp/vector.tar.gz https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz \
 && tar -xzf /tmp/vector.tar.gz -C /tmp \
 && cd /tmp/pgvector-0.8.7 \
 && make OPTFLAGS='' with_llvm=no \
 && make install with_llvm=no \
 && rm -rf /tmp/pgvector-0.8.7 /tmp/vector.tar.gz \
 && apk del .vector-build
