# Запуск в Ethereum mainnet

**Контракт в mainnet:** `0x15B87e1e71B48919CfD6fd23089642A1BA48aBf0`, блок 26193612, 15.10.2026; владелец — Safe `0xBDcEBBc53331a741316E4faaCf4bfD99D63Ad449` (2 из 3); деплой 3 092 394 газа при 0,139 gwei = 0,000430 ETH. Код в сети совпадает со сборкой репозитория. Данные деплоя — `contracts/deployments/chain-1.json`.

Порядок действий для выхода в mainnet. Тарифы и цены — в `contracts/mainnet-tiers.env`.

## Стоимость (оценка узла mainnet, 15.10.2026; ETH = $2300)

| Действие | Газ | При 0,15 gwei | При 1,5 gwei | При 5 gwei | При 20 gwei |
| --- | --- | --- | --- | --- | --- |
| Деплой контракта | 3 118 104 | ≈ 0,00047 ETH ($1,08) | ≈ 0,0047 ETH ($11) | ≈ 0,016 ETH ($36) | ≈ 0,062 ETH ($143) |
| Минт диска (платит покупатель) | ≈ 141 тыс. | ≈ $0,05 | ≈ $0,49 | ≈ $1,6 | ≈ $6,5 |
| Передача диска (платит владелец) | ≈ 60 тыс. | ≈ $0,02 | ≈ $0,21 | ≈ $0,7 | ≈ $2,8 |
| `setOperator` / `setTierActive` из Safe | ≈ 60–90 тыс. | ≈ $0,03 | < $0,3 | < $1 | < $4 |

В Sepolia тот же деплой стоит ≈ 22 млн газа: там уже действуют новые, более дорогие правила записи кода. Если они дойдут до mainnet раньше запуска, деплой подорожает в 6–7 раз. Перед деплоем всегда смотреть свежую оценку узла (см. шаг 3), а не оценку `forge script`.

## 1. Safe в mainnet

- app.safe.global → сеть Ethereum → создать Safe.
- Владельцы: **2 из 3** (не 2 из 2): например, аппаратный кошелёк, кошелёк на телефоне и запасной ключ, хранящийся отдельно. При «2 из 2» потеря любого ключа блокирует Safe навсегда.
- Записать адрес Safe.

## 2. Кошелёк для деплоя

- `deployer` (keystore Foundry) пополнить с запасом: скрипт требует «лимит газа × двойная текущая цена». При 0,15 gwei это ≈ 0,0012 ETH, удобно положить 0,003 ETH; при 1,5 gwei — ≈ 0,012 ETH (положить 0,02).
- Деплоер не получает никаких прав: владельцем сразу станет Safe.

## 3. Деплой — `contracts/script/deploy-mainnet.sh`

```bash
cd contracts
OWNER=<адрес Safe> DEPLOYER=<адрес деплоера> MAX_GWEI=1 ETHERSCAN_API_KEY=<ключ> ./script/deploy-mainnet.sh
```

Скрипт:
1. Проверяет, что RPC — это mainnet, а у `OWNER` есть код (это Safe, а не опечатка).
2. Собирает контракт, берёт оценку газа у узла (не у `forge script`), цену газа и баланс деплоера; печатает ожидаемую комиссию. Останавливается, если цена выше `MAX_GWEI` или денег не хватит.
3. Ждёт, пока вы введёте `DEPLOY`; `forge create` с лимитом «оценка × 1,2» спрашивает пароль keystore `deployer` (ключ скрипт не видит).
4. Проверяет контракт в сети: `name`, `owner` = Safe, все тарифы из `mainnet-tiers.env`.
5. Сохраняет адрес, блок и транзакцию в `contracts/deployments/chain-1.json`, верифицирует исходник на Etherscan (если задан ключ) и печатает строки для `.env` сервера и сборки сайта.

Если Foundry не в PATH: `FOUNDRY_BIN=<папка с forge и cast>`. Без `ETHERSCAN_API_KEY` скрипт печатает готовую команду верификации.

## 4. Проверка контракта в сети

```bash
C=<адрес контракта>; R=https://ethereum-rpc.publicnode.com
cast call $C "name()(string)" --rpc-url $R        # Etherdisk
cast call $C "owner()(address)" --rpc-url $R      # Safe
cast call $C "tierCount()(uint256)" --rpc-url $R  # 6
for i in 0 1 2 3 4 5; do cast call $C "getTier(uint256)((uint32,uint256,bool))" $i --rpc-url $R; done
```

## 5. Верификация на Etherscan

Ключ API — etherscan.io → API Keys.

```bash
forge verify-contract <адрес> src/Etherdisk.sol:Etherdisk --chain mainnet --etherscan-api-key <ключ> --watch \
  --constructor-args $(cast abi-encode "c(address,uint32[],uint256[],bool[])" <Safe> \
  "[64,128,256,512,1024,2048]" \
  "[5000000000000000,10000000000000000,20000000000000000,35000000000000000,65000000000000000,115000000000000000]" \
  "[true,true,true,false,false,false]")
```

После верификации Safe показывает функции контракта сам, ABI вручную вставлять не нужно.

## 6. Операторы

Из Safe (Transaction Builder): `setOperator(<кошелёк модератора>, true)` для каждого, кто будет открывать и закрывать продажу тарифов.

## 7. Сервер (`.env`)

```
CHAIN_ID=1
RPC_URL=https://ethereum-rpc.publicnode.com,https://mainnet.gateway.tenderly.co
CONTRACT_ADDRESS=<адрес контракта>
START_BLOCK=<блок деплоя>
CONFIRMATIONS=3
DATABASE_URL=sqlite:///<путь к базе>/etherdisk.db    # новая база: старая привязана к Sepolia
DATA_DIR=/mnt/raid1/etherdisk                         # тома через запятую
SIWE_DOMAIN=etherdisk.app
CORS_ORIGINS=https://etherdisk.app
TRUST_PROXY=true                                      # за nginx
IDEAS_ADMINS=<кошельки модераторов>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Точку монтирования каждого массива защитить от записи, пока он не примонтирован (`chattr +i` на пустую папку), чтобы сервер не принял её за новый пустой том.

## 8. Сайт (`web/.env.local` или переменные сборки)

```
NEXT_PUBLIC_CHAIN_ID=1
NEXT_PUBLIC_API_URL=https://api.etherdisk.app        # или тот же домен через nginx
NEXT_PUBLIC_RPC_URL=https://ethereum-rpc.publicnode.com,https://mainnet.gateway.tenderly.co
NEXT_PUBLIC_CONTRACT_ADDRESS=<адрес контракта>
NEXT_PUBLIC_WC_PROJECT_ID=<id из dashboard.reown.com, домен etherdisk.app в списке разрешённых>
```

`NEXT_PUBLIC_*` вшиваются при сборке: после изменения пересобрать (`npm run build`).

## 9. Проверка после запуска

1. Лендинг: шесть тарифов, у 512 ГБ, 1 ТБ и 2 ТБ — «Coming soon», нигде нет «Sepolia».
2. Вход кошельком, минт 64 ГБ: оплата приходит на Safe, у диска картинка на Etherscan.
3. Создание диска, загрузка файла, ссылка, ключ восстановления.
4. Модератор открывает и закрывает продажу тарифа (`setTierActive`) — сайт показывает изменение после обновления.
5. `/status` в Telegram: тома, база, индексатор, RPC без проблем.
6. Сервер в логе: `monitor: alerts go to Telegram`, свободное место томов.

## 10. Потом

- Открыть 512 ГБ / 1 ТБ / 2 ТБ операторами, когда вырастет хранилище.
- Цены при заметном движении курса ETH — `setTierPrice` из Safe.
- Деньги приходят прямо на Safe; `withdraw` нужен только если выплата не прошла (событие `PaymentHeld`).
