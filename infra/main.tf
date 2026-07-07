terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

data "aws_ami" "al2023_arm64" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-arm64"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  app_name = var.name

  tags = merge(
    {
      Name       = local.app_name
      Project    = "ai-workflow"
      Purpose    = "class-scoreboard"
      ManagedBy  = "terraform"
      Repository = "nxtcloud-edu/ai-workflow-scoreboard"
    },
    var.tags
  )

  parameter_names = compact([
    var.github_token_parameter_name,
    var.admin_password_parameter_name,
    var.session_secret_parameter_name
  ])

  parameter_arns = [
    for name in local.parameter_names :
    "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${startswith(name, "/") ? name : "/${name}"}"
  ]

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    aws_region                    = var.aws_region
    app_dir                       = var.app_dir
    repo_url                      = var.repo_url
    repo_branch                   = var.repo_branch
    port                          = var.port
    github_token_parameter_name   = var.github_token_parameter_name
    admin_password_parameter_name = var.admin_password_parameter_name
    session_secret_parameter_name = var.session_secret_parameter_name
    excluded_logins               = var.excluded_logins
    quality_ai_enabled            = var.quality_ai_enabled
    bedrock_model_id              = var.bedrock_model_id
  })
}

resource "aws_security_group" "scoreboard" {
  name_prefix = "${local.app_name}-"
  description = "AI workflow scoreboard HTTP and SSH"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.http_cidr_blocks
  }

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidr_blocks
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, {
    Name = "${local.app_name}-sg"
  })
}

resource "aws_iam_role" "scoreboard" {
  name_prefix = "${local.app_name}-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "runtime" {
  name = "scoreboard-runtime"
  role = aws_iam_role.scoreboard.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Effect = "Allow"
          Action = [
            "ssm:GetParameter"
          ]
          Resource = local.parameter_arns
        },
        {
          Effect = "Allow"
          Action = [
            "kms:Decrypt"
          ]
          Resource = "*"
        }
      ],
      var.enable_bedrock_policy ? [
        {
          Effect = "Allow"
          Action = [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream"
          ]
          Resource = "*"
        }
      ] : []
    )
  })
}

resource "aws_iam_instance_profile" "scoreboard" {
  name_prefix = "${local.app_name}-"
  role        = aws_iam_role.scoreboard.name

  tags = local.tags
}

resource "aws_instance" "scoreboard" {
  ami                         = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023_arm64.id
  instance_type               = var.instance_type
  subnet_id                   = var.subnet_id
  key_name                    = var.key_name
  vpc_security_group_ids      = [aws_security_group.scoreboard.id]
  iam_instance_profile        = aws_iam_instance_profile.scoreboard.name
  associate_public_ip_address = true
  user_data                   = local.user_data
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.root_volume_size
    volume_type = var.root_volume_type
    encrypted   = var.root_volume_encrypted
  }

  tags = local.tags
}
