variable "aws_region" {
  description = "AWS region for the scoreboard server."
  type        = string
  default     = "ap-northeast-2"
}

variable "name" {
  description = "Base name used for AWS resource tags and generated resource names."
  type        = string
  default     = "ai-workflow-scoreboard"
}

variable "vpc_id" {
  description = "VPC ID where the scoreboard EC2 instance will run."
  type        = string
  default     = "vpc-0cd95c4e2fffe3008"
}

variable "subnet_id" {
  description = "Subnet ID where the scoreboard EC2 instance will run."
  type        = string
  default     = "subnet-0b0dd8491ea3121dd"
}

variable "key_name" {
  description = "Existing EC2 key pair name for SSH access."
  type        = string
  default     = "nxt-workshop"
}

variable "ami_id" {
  description = "Optional AMI ID override. Leave empty to use the latest Amazon Linux 2023 arm64 AMI."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_size" {
  description = "Root EBS volume size in GiB."
  type        = number
  default     = 12
}

variable "root_volume_type" {
  description = "Root EBS volume type."
  type        = string
  default     = "gp3"
}

variable "root_volume_encrypted" {
  description = "Whether to encrypt the root EBS volume."
  type        = bool
  default     = false
}

variable "http_cidr_blocks" {
  description = "CIDR blocks allowed to access the public HTTP endpoint."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "ssh_cidr_blocks" {
  description = "CIDR blocks allowed to SSH into the instance."
  type        = list(string)
  default     = ["113.198.219.119/32"]
}

variable "repo_url" {
  description = "Git repository cloned by cloud-init on first boot."
  type        = string
  default     = "https://github.com/nxtcloud-edu/ai-workflow-scoreboard.git"
}

variable "repo_branch" {
  description = "Git branch deployed by cloud-init."
  type        = string
  default     = "main"
}

variable "app_dir" {
  description = "Remote application directory."
  type        = string
  default     = "/opt/ai-workflow-scoreboard"
}

variable "port" {
  description = "Local Astro server port proxied by nginx."
  type        = number
  default     = 4324
}

variable "github_token_parameter_name" {
  description = "SSM SecureString parameter name containing the repo-scoped GitHub token."
  type        = string
  default     = "/ai-workflow-scoreboard/github-token"
}

variable "admin_password_parameter_name" {
  description = "SSM SecureString parameter name containing SCOREBOARD_ADMIN_PASSWORD."
  type        = string
  default     = "/ai-workflow-scoreboard/admin-password"
}

variable "session_secret_parameter_name" {
  description = "SSM SecureString parameter name containing SCOREBOARD_ADMIN_SESSION_SECRET."
  type        = string
  default     = "/ai-workflow-scoreboard/session-secret"
}

variable "excluded_logins" {
  description = "Comma-separated GitHub logins excluded from scoring."
  type        = string
  default     = "glen15,Dang-Mu"
}

variable "quality_ai_enabled" {
  description = "Whether the app should call Bedrock quality evaluation at runtime."
  type        = bool
  default     = false
}

variable "enable_bedrock_policy" {
  description = "Whether the EC2 IAM role should include Bedrock InvokeModel permissions."
  type        = bool
  default     = true
}

variable "bedrock_model_id" {
  description = "Bedrock model ID used when quality_ai_enabled is true."
  type        = string
  default     = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "tags" {
  description = "Extra AWS tags applied to created resources."
  type        = map(string)
  default = {
    username = "glen.lee"
    group    = "admin"
  }
}
