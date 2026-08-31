resource "aws_lambda_function" "billing" {
  function_name = "billing"

  environment {
    variables = {
      KAFKA_TOPIC = "payments.captured"
    }
  }
}
