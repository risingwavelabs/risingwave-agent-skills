---
title: "Audit user privileges and access control"
impact: "HIGH"
impactDescription: "Ensure proper access control, identify privilege issues, support compliance"
tags: ["user", "privilege", "access-control", "rbac", "security", "audit", "schema", "database"]
---

## Problem Statement

RisingWave supports role-based access control (RBAC) with users, roles, and privilege grants. Misconfigured privileges can cause "permission denied" errors for streaming jobs, prevent DDL operations, or leave overly broad access that violates security policies. This guide covers auditing and troubleshooting access control.

## List Users and Roles

```sql
-- List all users with their properties
SELECT * FROM rw_users;
```

Output includes user ID, name, and system privileges (is_super, can_create_db, can_create_user, can_login).

## Check User Privileges

### System-level privileges

```sql
-- Check a specific user's system privileges
SELECT name, is_super, can_create_db, can_create_user, can_login
FROM rw_users
WHERE name = 'my_user';
```

### Schema ownership

```sql
-- Show which schemas a user owns
SELECT s.name AS schema_name, u.name AS owner
FROM rw_schemas s
JOIN rw_users u ON s.owner = u.id
WHERE u.name = 'my_user';
```

### Database ownership

```sql
-- Show which databases a user owns
SELECT d.name AS database_name, u.name AS owner
FROM rw_databases d
JOIN rw_users u ON d.owner = u.id
WHERE u.name = 'my_user';
```

### Table-level privileges

```sql
-- Check privileges on a specific table
SELECT * FROM rw_table_privileges WHERE table_name = 'my_table';
```

## Common Permission Issues

### Issue 1: "permission denied" on DDL operations

**Symptoms**: User cannot create MVs, tables, or sinks.

**Diagnosis**:
```sql
-- Check if user has CREATE privilege on the schema
SELECT * FROM rw_users WHERE name = 'my_user';
-- Check is_super — superusers bypass all checks
```

**Solution**: Grant the minimum necessary privileges:
```sql
-- Allow creating objects in the schema
GRANT CREATE ON SCHEMA public TO my_user;

-- Grant SELECT on upstream tables the user's MVs will read from
GRANT SELECT ON TABLE source_table1, source_table2 TO my_user;

-- Only use broad grants when the user genuinely needs access to all tables
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO my_user;
```

### Issue 2: Streaming job fails with permission error

**Symptoms**: MV creation fails because the user lacks SELECT on upstream tables.

**Solution**:
```sql
GRANT SELECT ON TABLE source_table TO my_user;
-- Or grant on all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO my_user;
```

### Issue 3: Sink cannot access source data

**Symptoms**: Sink creation fails with permission errors.

**Solution**:
```sql
GRANT SELECT ON TABLE my_mv TO sink_user;
```

## Security Audit Checklist

Run these queries periodically to audit access:

```sql
-- 1. List all superusers (should be minimal)
SELECT name FROM rw_users WHERE is_super = true;

-- 2. List all users who can create databases
SELECT name FROM rw_users WHERE can_create_db = true;

-- 3. List all users who can create other users
SELECT name FROM rw_users WHERE can_create_user = true;

-- 4. List object ownership (find orphaned objects from deleted users)
SELECT r.name AS object_name, r.relation_type, u.name AS owner
FROM rw_relations r
JOIN rw_users u ON r.owner = u.id
ORDER BY u.name, r.relation_type;
```

## User Management

### Create a user

```sql
CREATE USER app_reader WITH PASSWORD 'secure_password' LOGIN;
```

### Grant read-only access

```sql
-- Read-only on all current tables in public schema
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_reader;

-- Allow connecting
GRANT CONNECT ON DATABASE dev TO app_reader;
```

### Revoke access

```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM former_user;
```

## Reference

- [User and Access Control](https://docs.risingwave.com/sql/commands/sql-create-user)
- [GRANT](https://docs.risingwave.com/sql/commands/sql-grant)
- [REVOKE](https://docs.risingwave.com/sql/commands/sql-revoke)
