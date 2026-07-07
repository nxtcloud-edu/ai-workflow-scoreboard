output "instance_id" {
  description = "Created EC2 instance ID."
  value       = aws_instance.scoreboard.id
}

output "public_ip" {
  description = "Created EC2 public IP. This is not an Elastic IP."
  value       = aws_instance.scoreboard.public_ip
}

output "url" {
  description = "Public HTTP URL for the scoreboard."
  value       = "http://${aws_instance.scoreboard.public_ip}/"
}

output "security_group_id" {
  description = "Security group attached to the instance."
  value       = aws_security_group.scoreboard.id
}

output "iam_role_name" {
  description = "IAM role attached to the instance profile."
  value       = aws_iam_role.scoreboard.name
}
