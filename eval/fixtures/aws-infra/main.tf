data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

resource "aws_launch_template" "app" {
  name_prefix            = "${var.app_name}-"
  image_id               = data.aws_ami.al2023.id
  instance_type          = "t3.small"
  vpc_security_group_ids = [aws_security_group.app.id]

  iam_instance_profile {
    name = aws_iam_instance_profile.app.name
  }

  metadata_options {
    http_tokens = "required"
  }
}

resource "aws_autoscaling_group" "app" {
  name                = "${var.app_name}-app"
  min_size            = 2
  max_size            = 4
  vpc_zone_identifier = module.vpc.private_subnets

  launch_template {
    id      = aws_launch_template.app.id
    version = "$Latest"
  }
}
