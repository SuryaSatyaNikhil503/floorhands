output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "app_role_arn" {
  value = aws_iam_role.app.arn
}
