# Pinned toolchain for building open-pal paks: repak (with the Oodle library it loads) and uasset-json.
FROM mcr.microsoft.com/dotnet/sdk:8.0@sha256:6ba9644da07bb5b560a402acec9ca38711a0762969f1b61da261df5c9f6f85da AS uasset-json
WORKDIR /src
COPY uasset-json/ ./
RUN dotnet restore --locked-mode && dotnet publish --no-restore -c Release -o /out

FROM mcr.microsoft.com/dotnet/runtime:8.0@sha256:67e16b7d568208713e05db7f7bcc81827679a636222160bf57bb148acd23622e
ARG REPAK_VERSION=0.2.3
ARG REPAK_SHA256=933bdb8e26f34e8fd70ea50201efca39df041de58aa83b1cd6eb83da124a2046
# The Oodle build and hash repak 0.2.3 itself downloads on first use (oodle_loader/src/lib.rs).
ARG OODLE_URL=https://github.com/WorkingRobot/OodleUE/raw/refs/heads/main/Engine/Source/Programs/Shared/EpicGames.Oodle/Sdk/2.9.10/linux/lib/liboo2corelinux64.so.9
ARG OODLE_SHA256=ed7e98f70be1254a80644efd3ae442ff61f854a2fe9debb0b978b95289884e9c

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
  && curl -fsSL -o /tmp/repak.tar.xz "https://github.com/trumank/repak/releases/download/v${REPAK_VERSION}/repak_cli-x86_64-unknown-linux-gnu.tar.xz" \
  && echo "${REPAK_SHA256}  /tmp/repak.tar.xz" | sha256sum -c - \
  && mkdir -p /opt/repak \
  && tar -xJf /tmp/repak.tar.xz -C /opt/repak --strip-components=1 \
  && curl -fsSL -o /opt/repak/liboo2corelinux64.so.9 "${OODLE_URL}" \
  && echo "${OODLE_SHA256}  /opt/repak/liboo2corelinux64.so.9" | sha256sum -c - \
  && ln -s /opt/repak/repak /usr/local/bin/repak \
  && apt-get purge -y curl xz-utils \
  && rm -rf /var/lib/apt/lists/* /tmp/repak.tar.xz

COPY --from=uasset-json /out /opt/uasset-json
RUN printf '#!/bin/sh\nexec dotnet /opt/uasset-json/UAssetJson.dll "$@"\n' > /usr/local/bin/uasset-json \
  && chmod +x /usr/local/bin/uasset-json

WORKDIR /work
