1. Pengelompokan

| Domain event     | Dipicu oleh               | Data inti              |
| ---------------- | ------------------------- | ---------------------- |
| `UserRegistered` | calon pelanggan mendaftar | email, password (hash) |
| `UserLoggedIn`   | pelanggan login           | kredensial → token     |
| `ProductCreated` | admin menambah produk     | nama, harga, stok      |

2. Bounded context
```mermaid
flowchart LR
  FE[frontend] --> GW[gateway]
  GW --> AUTH[auth-service<br/>akun & token]
  GW --> PROD[product-service<br/>katalog & stok]
  GW --> ORD[order-service<br/>pesanan]
  ORD -- HTTP --> PROD
  PROD -. JWKS .-> AUTH
  ORD -. JWKS .-> AUTH
```

3. Alasan Pemisahan


4. Cara desain ini menghindari tiga anti-pattern


5. Pengantar Saga