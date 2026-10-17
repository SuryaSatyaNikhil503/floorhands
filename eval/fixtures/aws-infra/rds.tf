resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-db"
  subnet_ids = module.vpc.public_subnets
}

resource "aws_db_instance" "main" {
  identifier             = "${var.app_name}-db"
  engine                 = "postgres"
  engine_version         = "15.5"
  instance_class         = "db.t3.medium"
  allocated_storage      = 50
  db_name                = "orders"
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  publicly_accessible     = true
  backup_retention_period = 0
  skip_final_snapshot     = true
  multi_az                = false
}
