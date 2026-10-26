# Запуск в Ethereum mainnet

**Контракт в mainnet:** `0x15B87e1e71B48919CfD6fd23089642A1BA48aBf0`, блок 26193612, 15.10.2026; владелец — Safe `0xBDcEBBc53331a741316E4faaCf4bfD99D63Ad449` (2 из 3); деплой 3 092 394 газа при 0,139 gwei = 0,000430 ETH. Код в сети совпадает со сборкой репозитория; исходник верифицирован на Etherscan и отправлен на Sourcify. Данные деплоя — `contracts/deployments/chain-1.json`.

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

Разворачиваются два контракта: **`EtherdiskRenderer`** (картинка и метаданные NFT; его можно заменить, пока метаданные не заморожены) и **`Etherdisk`** (диски, тарифы, выплаты). Настройки — в `contracts/mainnet-tiers.env`: тарифы, их цвета, роялти (`ROYALTY_BPS`, 500 = 5 %) и адрес страницы диска в метаданных (`PAGE_BASE`).

Скрипт:
1. Проверяет, что RPC — это mainnet, а у `OWNER` есть код (это Safe, а не опечатка).
2. Собирает контракты, берёт оценку газа у узла (не у `forge script`) для обоих, цену газа и баланс деплоера; печатает ожидаемую комиссию. Останавливается, если цена выше `MAX_GWEI` или денег не хватит.
3. Ждёт, пока вы введёте `DEPLOY`; два `forge create` с лимитом «оценка × 1,2», каждый спрашивает пароль keystore `deployer` (ключ скрипт не видит).
4. Проверяет контракты в сети: `name`, `owner` = Safe, `renderer` и его `pageBase`, роялти, все тарифы с ценами и цветами из `mainnet-tiers.env`.
5. Сохраняет адреса, блок и транзакции в `contracts/deployments/chain-1.json`, верифицирует оба исходника на Etherscan (если задан ключ) и печатает строки для `.env` сервера и сборки сайта.

Если Foundry не в PATH: `FOUNDRY_BIN=<папка с forge и cast>`. Без `ETHERSCAN_API_KEY` скрипт печатает готовую команду верификации.

## 4. Проверка контракта в сети

```bash
C=<адрес контракта>; R=https://ethereum-rpc.publicnode.com
cast call $C "name()(string)" --rpc-url $R        # Etherdisk
cast call $C "owner()(address)" --rpc-url $R      # Safe
cast call $C "tierCount()(uint256)" --rpc-url $R  # 6
for i in 0 1 2 3 4 5; do cast call $C "getTier(uint256)((uint32,uint24,bool,bool,uint256))" $i --rpc-url $R; done
cast call $C "renderer()(address)" --rpc-url $R
cast call $C "royaltyInfo(uint256,uint256)(address,uint256)" 1 10000 --rpc-url $R   # Safe, 500
```

`getTier` отдаёт объём, цвет (`0xrrggbb` числом), «в продаже», «скрыт» и цену.

## 5. Верификация на Etherscan

Ключ API — etherscan.io → API Keys.

Скрипт деплоя верифицирует оба контракта сам, если задан `ETHERSCAN_API_KEY`; иначе печатает обе команды `forge verify-contract` с уже закодированными аргументами конструктора (они же — в `contracts/deployments/chain-1.json`).

После верификации Safe показывает функции контракта сам, ABI вручную вставлять не нужно.

## 6. Операторы

Из Safe (Transaction Builder): `setOperator(<кошелёк модератора>, true)` для каждого, кто будет открывать и закрывать продажу тарифов и скрывать их с сайта.

Что ещё может владелец (Safe):
- `addTier(объём, цена, цвет)` — новый тариф; он не продаётся, пока не открыть продажу (`setTierActive`);
- `setTierHidden(тариф, true)` — убрать тариф из списка на сайте (купленные диски не меняются); это может и оператор;
- `setTierPrice`, `setTierColor` — цена и цвет; новый цвет меняет картинки дисков этого тарифа, маркетплейсы получают уведомление (ERC-4906) и обновляют карточки;
- `setRenderer` — заменить рендерер метаданных (исправить картинку или текст), `freezeMetadata()` — запретить это навсегда (и смену цветов тоже);
- `setRoyalty(получатель, bps)` — роялти с перепродаж, не больше 10 %.

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
CORS_ORIGINS=https://etherdisk.app,http://app.localhost,app://localhost   # сайт и приложение для ПК
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
