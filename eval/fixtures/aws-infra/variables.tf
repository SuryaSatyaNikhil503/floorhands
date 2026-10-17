variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "app_name" {
  type    = string
  default = "orders"
}

variable "db_username" {
  type    = string
  default = "orders_app"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}
